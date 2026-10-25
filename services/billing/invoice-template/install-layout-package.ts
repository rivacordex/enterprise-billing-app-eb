import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { billTemplateFamilyRepository } from "@/db/repositories/billing/bill-template-family";
import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";
import { logger } from "@/lib/logger";
import { blobStore } from "@/services/billing/blob-store";
import { sha256 } from "@/services/billing/invoice-template/checksum-index";
import type {
  InvoiceTemplateStructure,
  UploadLayoutPackageResult,
} from "@/types/billing";
import type { LayoutManifest } from "@/validation/billing/layout-manifest.schema";

// bm78 (Inv #59) — the ONLY writer of layout DRAFT rows, their blobs and the settings
// DRAFT that points at them. bm80 adds the in-place overwrite branch here.
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
    readonly code: "TEMPLATE_TYPE_RETIRED" | "DRAFT_CHANGED_SINCE_WARNING",
  ) {
    super(code);
  }
}

export async function installLayoutPackage(args: {
  familyId: string;
  layoutCode: string;
  versionNo: number;
  files: Map<string, Buffer>;
  manifest: LayoutManifest;
  indexDigest: string;
  actorId: string;
}): Promise<UploadLayoutPackageResult> {
  const {
    familyId,
    layoutCode,
    versionNo,
    files,
    manifest,
    indexDigest,
    actorId,
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

        const openLayout = await billTemplateVersionRepository.findDraft(tx, {
          kind: "layout",
          familyId,
        });
        const next = await billTemplateVersionRepository.nextVersionNo(tx, {
          kind: "layout",
          familyId,
        });
        if (openLayout || next !== versionNo) {
          throw new InstallRollback("DRAFT_CHANGED_SINCE_WARNING");
        }

        const layout = await billTemplateVersionRepository.insertLayoutDraft(
          tx,
          {
            familyId,
            layoutCode,
            versionNo,
            pageSetup: manifest.pageSetup,
            blobRef: `${CONTAINER}/${dir}/`,
            checksum: indexDigest,
            createdBy: actorId,
          },
        );

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
          const base =
            (await billTemplateVersionRepository.findActive(tx, {
              kind: "generated",
              familyId,
            })) ??
            (await billTemplateVersionRepository.findDefault(tx, {
              kind: "generated",
              familyId,
            }));
          const structure =
            (base?.structure as InvoiceTemplateStructure | null | undefined) ??
            ({
              sections: { payment: true },
              columns: {},
              footnote: await standardFootnote(tx),
            } satisfies InvoiceTemplateStructure);
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
          beforeData: null,
          afterData: {
            familyId,
            versionNo,
            replaced: false,
            blobRef: layout.blobRef,
            checksum: indexDigest,
            fileCount: files.size,
            settingsDraftId,
          },
        });

        return {
          ok: true,
          versionId: layout.billTemplateVersionId,
          versionNo,
          replaced: false,
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
