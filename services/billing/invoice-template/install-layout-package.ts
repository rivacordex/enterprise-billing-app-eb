import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { billTemplateFamilyRepository } from "@/db/repositories/billing/bill-template-family";
import {
  billTemplateVersionRepository,
  type TemplateDraftRow,
} from "@/db/repositories/billing/bill-template-version";
import { logger } from "@/lib/logger";
import { blobStore } from "@/services/billing/blob-store";
import { sha256 } from "@/services/billing/invoice-template/checksum-index";
import type {
  ExpectedDraft,
  InvoiceTemplateStructure,
  LayoutPageSetup,
  UploadLayoutPackageResult,
} from "@/types/billing";
import { invoiceTemplateStructureSchema } from "@/validation/billing/invoice-template-structure.schema";
import type { LayoutManifest } from "@/validation/billing/layout-manifest.schema";

// bm78 (Inv #59) — the ONLY writer of layout DRAFT rows, their blobs and the settings
// DRAFT that points at them. bm80 adds the in-place overwrite: the open layout
// DRAFT the warning named keeps its row and version_no and takes the new files
// (a new content-addressed folder; the replaced files stay in the blob store),
// and the settings DRAFT is kept with its token bumped (Inv #59, #62).
//
// Blobs first, rows second: every file is written write-once under a
// content-addressed directory (the digest of the package's own checksums.json),
// then ONE locked transaction re-checks the type and inserts the rows. A failure
// after the blob writes leaves orphan blobs only; a retry of the same package
// reuses them (`onExists: "returnExisting"`).

const CONTAINER = "invoice-templates" as const;

function contentTypeFor(name: string): string {
  if (name.endsWith(".hbs")) return "text/x-handlebars-template; charset=utf-8";
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".woff2")) return "font/woff2";
  return "text/plain; charset=utf-8";
}

// Thrown inside the transaction to roll it back, then mapped to a result
// outside (a returned value would COMMIT).
class InstallRollback extends Error {
  constructor(
    readonly code:
      | "TEMPLATE_TYPE_RETIRED"
      | "DRAFT_CHANGED_SINCE_WARNING"
      | "SERVER_ERROR",
  ) {
    super(code);
  }
}

// bm80 — the expected draft against the type's open layout DRAFT (read with
// its token). `"stale"` is DRAFT_CHANGED_SINCE_WARNING: a draft appeared since
// the dialog opened, someone overwrote the warned-about one, or it was
// activated, discarded or replaced. The service checks without a lock and
// install re-checks under the type lock.
export function matchExpectedDraft(
  openLayoutDraft: Pick<
    TemplateDraftRow,
    "billTemplateVersionId" | "token"
  > | null,
  expectedDraft: ExpectedDraft,
): "create" | "overwrite" | "stale" {
  if ("none" in expectedDraft) {
    return openLayoutDraft === null ? "create" : "stale";
  }
  return openLayoutDraft !== null &&
    openLayoutDraft.billTemplateVersionId === expectedDraft.versionId &&
    openLayoutDraft.token === expectedDraft.lastModified
    ? "overwrite"
    : "stale";
}

export async function installLayoutPackage(args: {
  familyId: string;
  layoutCode: string;
  versionNo: number;
  files: Map<string, Buffer>;
  manifest: LayoutManifest;
  indexDigest: string;
  actorId: string;
  mode: "create" | "overwrite";
  expectedDraft: ExpectedDraft;
}): Promise<UploadLayoutPackageResult> {
  const {
    familyId,
    layoutCode,
    versionNo,
    files,
    manifest,
    indexDigest,
    actorId,
    mode,
    expectedDraft,
  } = args;
  const dir = `layouts/${layoutCode}/v${versionNo}-${indexDigest.slice(0, 12)}`;

  for (const [name, bytes] of files) {
    const put = await blobStore.putObject(
      CONTAINER,
      `${dir}/${name}`,
      bytes,
      contentTypeFor(name),
      {
        writeOnce: true,
        onExists: "returnExisting",
        checksumAlgorithm: "sha256",
      },
    );
    if (put.checksum !== sha256(bytes)) {
      logger.error("LAYOUT_BLOB_CONFLICT", {
        familyId,
        versionNo,
        file: `${dir}/${name}`,
      });
      return { ok: false, code: "SERVER_ERROR", problems: [] };
    }
  }

  try {
    return await db.transaction(
      async (tx): Promise<UploadLayoutPackageResult> => {
        const type = await billTemplateFamilyRepository.lockTemplateType(
          tx,
          familyId,
          "update",
        );
        if (!type || type.retiredDatetime !== null) {
          throw new InstallRollback("TEMPLATE_TYPE_RETIRED");
        }
        // Serialises with save-draft, which takes only this advisory lock.
        await billTemplateVersionRepository.lockKind(tx, { kind: "generated" });

        // Re-read the type's layout DRAFT under a row lock, with its token: the
        // request must still match the mode the service chose (bm80).
        const found = await billTemplateVersionRepository.findDraft(tx, {
          kind: "layout",
          familyId,
        });
        const current = found
          ? await billTemplateVersionRepository.findDraftForUpdate(
              tx,
              found.billTemplateVersionId,
            )
          : null;
        if (matchExpectedDraft(current, expectedDraft) !== mode) {
          throw new InstallRollback("DRAFT_CHANGED_SINCE_WARNING");
        }

        let layout: { billTemplateVersionId: string; blobRef: string | null };
        let previous: {
          blobRef: string | null;
          checksum: string | null;
          pageSetup: LayoutPageSetup | null;
        } | null = null;
        if (mode === "create") {
          const next = await billTemplateVersionRepository.nextVersionNo(tx, {
            kind: "layout",
            familyId,
          });
          if (next !== versionNo) {
            throw new InstallRollback("DRAFT_CHANGED_SINCE_WARNING");
          }
          layout = await billTemplateVersionRepository.insertLayoutDraft(tx, {
            familyId,
            layoutCode,
            versionNo,
            pageSetup: manifest.pageSetup,
            blobRef: `${CONTAINER}/${dir}/`,
            checksum: indexDigest,
            createdBy: actorId,
          });
        } else {
          // matchExpectedDraft returned "overwrite": both are set.
          if (!current || "none" in expectedDraft) {
            throw new InstallRollback("DRAFT_CHANGED_SINCE_WARNING");
          }
          const overwritten =
            await billTemplateVersionRepository.overwriteLayoutDraft(tx, {
              id: current.billTemplateVersionId,
              expectedToken: expectedDraft.lastModified,
              blobRef: `${CONTAINER}/${dir}/`,
              checksum: indexDigest,
              pageSetup: manifest.pageSetup,
              actorId,
            });
          if (overwritten === null) {
            throw new InstallRollback("DRAFT_CHANGED_SINCE_WARNING");
          }
          layout = overwritten.row;
          previous = {
            blobRef: current.blobRef,
            checksum: current.checksum,
            pageSetup: current.pageSetup,
          };
        }

        // The settings DRAFT: re-point the open one (bumping its token, Inv #62),
        // or create one from known values.
        let settingsDraftId: string;
        const settings = await billTemplateVersionRepository.findDraft(tx, {
          kind: "generated",
          familyId,
        });
        if (settings) {
          const token = await billTemplateVersionRepository.repointDraftLayout(
            tx,
            {
              id: settings.billTemplateVersionId,
              layoutVersionId: layout.billTemplateVersionId,
              actorId,
            },
          );
          if (token === null)
            throw new InstallRollback("DRAFT_CHANGED_SINCE_WARNING");
          settingsDraftId = settings.billTemplateVersionId;
        } else {
          // Review fix (Data rule 9) — the structure is validated before it is
          // written: the type's current settings, else a Payment-on default
          // with Standard's footnote. A catalog where neither passes (e.g. a
          // stale seed with no footnote) needs the bm64 reset; nothing is
          // written and the failure is logged.
          const base =
            (await billTemplateVersionRepository.findActive(tx, {
              kind: "generated",
              familyId,
            })) ??
            (await billTemplateVersionRepository.findDefault(tx, {
              kind: "generated",
              familyId,
            }));
          const fromBase = invoiceTemplateStructureSchema.safeParse(
            base?.structure,
          );
          const parsed = fromBase.success
            ? fromBase
            : invoiceTemplateStructureSchema.safeParse({
                sections: { payment: true },
                columns: {},
                footnote: await standardFootnote(tx),
              } satisfies InvoiceTemplateStructure);
          if (!parsed.success) {
            logger.error("LAYOUT_INSTALL_STRUCTURE_INVALID", {
              familyId,
              baseVersionId: base?.billTemplateVersionId ?? null,
              issues: parsed.error.issues.map((i) => i.path.join(".")),
            });
            throw new InstallRollback("SERVER_ERROR");
          }
          const structure = parsed.data;
          const created = await billTemplateVersionRepository.insertDraft(tx, {
            versionNo: await billTemplateVersionRepository.nextVersionNo(tx, {
              kind: "generated",
              familyId,
            }),
            refLayoutVersionId: layout.billTemplateVersionId,
            refBillTemplateFamilyId: familyId,
            structure,
            createdBy: actorId,
          });
          settingsDraftId = created.billTemplateVersionId;
        }

        await insertAuditEvent(tx, {
          eventType: "INVOICE_TEMPLATE_LAYOUT_UPLOADED",
          actorUserId: actorId,
          targetEntity: "BILL_TEMPLATE_VERSION",
          targetId: layout.billTemplateVersionId,
          beforeData: previous,
          afterData: {
            familyId,
            versionNo,
            replaced: mode === "overwrite",
            blobRef: layout.blobRef,
            checksum: indexDigest,
            pageSetup: manifest.pageSetup,
            fileCount: files.size,
            settingsDraftId,
            previousBlobRef: previous?.blobRef ?? null,
            previousChecksum: previous?.checksum ?? null,
          },
        });

        return {
          ok: true,
          versionId: layout.billTemplateVersionId,
          versionNo,
          replaced: mode === "overwrite",
        };
      },
    );
  } catch (error) {
    if (error instanceof InstallRollback) {
      return { ok: false, code: error.code, problems: [] };
    }
    throw error;
  }
}

// A new type's first settings start from the Standard type's ACTIVE (or
// default) footnote.
async function standardFootnote(
  tx: Parameters<typeof billTemplateFamilyRepository.findDefault>[0],
): Promise<string[]> {
  const standard = await billTemplateFamilyRepository.findDefault(tx);
  if (!standard) return [];
  const row =
    (await billTemplateVersionRepository.findActive(tx, {
      kind: "generated",
      familyId: standard.billTemplateFamilyId,
    })) ??
    (await billTemplateVersionRepository.findDefault(tx, {
      kind: "generated",
      familyId: standard.billTemplateFamilyId,
    }));
  const footnote = (row?.structure as InvoiceTemplateStructure | null)
    ?.footnote;
  return Array.isArray(footnote) ? [...footnote] : [];
}
