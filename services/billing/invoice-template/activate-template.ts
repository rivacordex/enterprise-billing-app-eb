import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { billTemplateFamilyRepository } from "@/db/repositories/billing/bill-template-family";
import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";
import type { BillTemplateVersion } from "@/db/schema/billing/bill-template-version";
import { blobStore } from "@/services/billing/blob-store";
import {
  generate,
  layoutFilesFromVerified,
} from "@/services/billing/invoice-template/generate";
import {
  loadLayout,
  loadLayoutDraft,
} from "@/services/billing/invoice-template/load";
import {
  buildChecksumIndex,
  sha256,
} from "@/services/billing/invoice-template/checksum-index";
import type { renderAndReadSections } from "@/services/billing/invoice-template/compliance-render";
import { parseSampleData } from "@/services/billing/invoice-template/sample-data";
import { testRender } from "@/services/billing/invoice-template/test-render";
import { checkLayoutFiles } from "@/services/billing/invoice-template/upload-layout-package";
import {
  InvoiceRenderError,
  type InvoiceErrorCode,
  type LayoutProblem,
  type TemplateActivationErrorCode,
  type TemplateDraftErrorCode,
  type TemplatePairActivationErrorCode,
} from "@/types/billing";
import {
  activateTemplateInputSchema,
  type ActivateTemplateInput,
} from "@/validation/billing/activate-version.schema";
import { invoiceTemplateStructureSchema } from "@/validation/billing/invoice-template-structure.schema";

// bm58-spec §Design D2 (Inv #41/#42/#44/#45/#46/#49, General rule 10): activate
// the saved working DRAFT. All-or-nothing, in this order, and the previous
// ACTIVE version is untouched by every failure:
//
//   2. read the type and the draft (no lock), token + status, re-parse its
//      structure; a retired type is TEMPLATE_TYPE_RETIRED (bm79, Inv #67)
//   3. load the layout (checksum-verified). bm79: when the settings DRAFT
//      points at a layout DRAFT of its type (the PAIR an upload created), it
//      loads through `loadLayoutDraft` and the compliance check is re-run
//      (`checkLayoutFiles`, Inv #61/#63); a failure is LAYOUT_REJECTED
//   4. generate invoice.hbs / footer.hbs / structure.json
//   5. test-render both in a fresh compile against the layout's sample bill
//   6. build checksums.json; the directory is content-addressed under the
//      type code, `generated/INVOICE/<type code>/v<n>-<digest12>/` (bm79; rows
//      activated before keep their stored `blob_ref`)
//   7. write the four files write-once (blob store)
//   8. ONE transaction: lock the type, then the kind (the install order,
//      Inv #66), re-read the draft FOR UPDATE (its token, Inv #62); for a
//      pair, re-read the layout DRAFT, retire the previous non-default ACTIVE
//      layout and promote the layout DRAFT (files frozen); then retire the
//      previous non-default ACTIVE settings, promote the draft, audit
//
// Steps 3-7 run outside any database transaction. A failure in step 8 rolls it
// back and leaves the step-7 blobs as harmless orphans: they are write-once and
// never deleted inline (workflow rules §6.7), and the content-addressed path
// makes an identical retry find identical bytes instead of colliding.

// Render failures the caller can act on, returned as result codes; anything
// else is a real fault and propagates. One tuple feeds both the runtime guard
// and the result type, so they cannot drift.
const RETURNED_RENDER_CODES = [
  "TEMPLATE_CHECKSUM_MISMATCH",
  "TEMPLATE_VERSION_NOT_FOUND",
  "TEMPLATE_GENERATION_FAILED",
  "TEMPLATE_COMPILE_FAILED",
  "MANDATORY_SECTION_HIDDEN",
] as const satisfies readonly InvoiceErrorCode[];
type ReturnedRenderCode = (typeof RETURNED_RENDER_CODES)[number];

function isReturnedRenderCode(
  code: InvoiceErrorCode,
): code is ReturnedRenderCode {
  return (RETURNED_RENDER_CODES as readonly InvoiceErrorCode[]).includes(code);
}

export type ActivateTemplateErrorCode =
  | TemplateActivationErrorCode
  | TemplateDraftErrorCode
  | ReturnedRenderCode
  | TemplatePairActivationErrorCode
  | "VALIDATION_ERROR";

export type ActivateTemplateResult =
  | {
      ok: true;
      versionId: string;
      versionNo: number;
      retiredVersionId: string | null;
      blobRef: string;
      checksum: string;
      // bm79 — the layout DRAFT promoted with the settings; `null` for a
      // settings-only activation.
      layout: {
        versionId: string;
        versionNo: number;
        retiredVersionId: string | null;
      } | null;
    }
  | { ok: false; code: Exclude<ActivateTemplateErrorCode, "LAYOUT_REJECTED"> }
  | { ok: false; code: "LAYOUT_REJECTED"; problems: LayoutProblem[] };

// The test render lives in its own module since bm79; re-exported for callers.
export { testRender };

const CONTAINER = "invoice-templates" as const;

const CONTENT_TYPES = {
  "invoice.hbs": "text/x-handlebars-template; charset=utf-8",
  "footer.hbs": "text/x-handlebars-template; charset=utf-8",
  "structure.json": "application/json",
  "checksums.json": "application/json",
} as const;

// Thrown inside the step-8 transaction to roll it back, then mapped to a result
// outside (a returned value would COMMIT the retirement).
class ActivationRollback extends Error {
  constructor(readonly code: "DRAFT_CONFLICT" | "TEMPLATE_TYPE_RETIRED") {
    super(code);
  }
}

export async function activateTemplate(
  rawInput: ActivateTemplateInput,
  actorId: string,
  // bm79 — the compliance re-run's renderer (the DB-gated suites stub it).
  deps: { render?: typeof renderAndReadSections } = {},
): Promise<ActivateTemplateResult> {
  // Step 1 (defense in depth; the action parsed already).
  const parsed = activateTemplateInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const noteMissing = parsed.error.issues.some(
      (i) => i.message === "CHANGE_NOTE_REQUIRED",
    );
    return {
      ok: false,
      code: noteMissing ? "CHANGE_NOTE_REQUIRED" : "VALIDATION_ERROR",
    };
  }
  const { draftId, expectedDraftToken, changeNote, familyId } = parsed.data;

  // Step 2: the draft, as the form last saw it — the working draft of the
  // type named by the `[typeId]` page (bm77; review fix §24c).
  const family = await billTemplateFamilyRepository.findById(db, familyId);
  // bm79 (Inv #67) — the early answer; step 8 re-checks it under the lock.
  if (family && family.retiredDatetime !== null) {
    return { ok: false, code: "TEMPLATE_TYPE_RETIRED" };
  }
  const draft = family
    ? await billTemplateVersionRepository.findDraft(db, {
        kind: "generated",
        familyId: family.billTemplateFamilyId,
      })
    : null;
  if (
    !family ||
    !draft ||
    draft.billTemplateVersionId !== draftId ||
    draft.token !== expectedDraftToken
  ) {
    return { ok: false, code: "DRAFT_CONFLICT" };
  }
  const structure = invoiceTemplateStructureSchema.safeParse(draft.structure);
  if (!structure.success) {
    // Only the mandatory-section rule is "a required section is hidden"; any
    // other schema failure (an unknown key, a missing column key, a wrong type)
    // is an invalid stored structure and must not be reported as that.
    const hidden = structure.error.issues.some(
      (i) => i.message === "MANDATORY_SECTION_HIDDEN",
    );
    return {
      ok: false,
      code: hidden ? "MANDATORY_SECTION_HIDDEN" : "VALIDATION_ERROR",
    };
  }
  if (draft.refLayoutVersionId === null) {
    return { ok: false, code: "TEMPLATE_VERSION_NOT_FOUND" };
  }

  let files: Map<string, Buffer>;
  let dir: string;
  let indexDigest: string;
  let pairLayout: BillTemplateVersion | null;
  try {
    // Step 3: the layout, checksum-verified. bm79: a layout DRAFT is checked
    // again — `compliance.ts` may have gained a rule since the upload, and a
    // row could reach DRAFT by an SQL bypass. `btv_pair_same_type_fk`
    // guarantees it is this type's own layout.
    const layoutRow = await billTemplateVersionRepository.findById(
      db,
      draft.refLayoutVersionId,
    );
    if (!layoutRow) return { ok: false, code: "TEMPLATE_VERSION_NOT_FOUND" };
    pairLayout = layoutRow.status === "DRAFT" ? layoutRow : null;
    const layoutFiles = pairLayout
      ? await loadLayoutDraft(pairLayout)
      : await loadLayout(layoutRow);
    if (pairLayout) {
      const problems = await checkLayoutFiles(layoutFiles, deps.render);
      if (problems.length > 0) {
        return { ok: false, code: "LAYOUT_REJECTED", problems };
      }
    }

    // Step 4: generate.
    const generated = generate(
      layoutFilesFromVerified(layoutFiles),
      structure.data,
    );

    // Step 5: test-render.
    testRender(
      generated.invoiceHbs,
      generated.footerHbs,
      parseSampleData(layoutFiles),
    );

    // Step 6: checksums and the content-addressed directory. bm79: under the
    // immutable type code (Inv #65), so two types' v1 never share a folder.
    files = new Map<string, Buffer>([
      ["invoice.hbs", Buffer.from(generated.invoiceHbs, "utf-8")],
      ["footer.hbs", Buffer.from(generated.footerHbs, "utf-8")],
      ["structure.json", Buffer.from(generated.structureJson, "utf-8")],
    ]);
    const indexBytes = buildChecksumIndex(files);
    files.set("checksums.json", indexBytes);
    indexDigest = sha256(indexBytes);
    dir = `generated/INVOICE/${family.code}/v${draft.versionNo}-${indexDigest.slice(0, 12)}`;
  } catch (error) {
    if (
      error instanceof InvoiceRenderError &&
      isReturnedRenderCode(error.code)
    ) {
      return { ok: false, code: error.code };
    }
    throw error;
  }

  // Step 7: write-once. An existing blob with the same bytes is fine (an
  // identical retry); different bytes at the same path abort the activation.
  for (const [name, bytes] of files) {
    const put = await blobStore.putObject(
      CONTAINER,
      `${dir}/${name}`,
      bytes,
      CONTENT_TYPES[name as keyof typeof CONTENT_TYPES],
      {
        writeOnce: true,
        onExists: "returnExisting",
        checksumAlgorithm: "sha256",
      },
    );
    if (put.checksum !== sha256(bytes)) {
      return { ok: false, code: "ACTIVATION_BLOB_CONFLICT" };
    }
  }

  // Step 8: one transaction. Retire BEFORE promote
  // (`btv_one_active_family_uq`, bm64; per (type, kind) since bm74), the
  // layout before the settings.
  const blobRef = `${CONTAINER}/${dir}/`;
  try {
    return await db.transaction(async (tx): Promise<ActivateTemplateResult> => {
      // bm79 (Inv #66) — the type row first, then the kind: the install order,
      // so an upload and an activation of one type are fully serialised.
      const type = await billTemplateFamilyRepository.lockTemplateType(
        tx,
        familyId,
        "update",
      );
      if (!type || type.retiredDatetime !== null) {
        throw new ActivationRollback("TEMPLATE_TYPE_RETIRED");
      }
      await billTemplateVersionRepository.lockKind(tx, { kind: "generated" });

      const locked = await billTemplateVersionRepository.findDraftForUpdate(
        tx,
        draftId,
      );
      if (
        !locked ||
        locked.token !== expectedDraftToken ||
        // bm77 — the draft must belong to the type the page named.
        locked.refBillTemplateFamilyId !== familyId
      ) {
        throw new ActivationRollback("DRAFT_CONFLICT");
      }

      // The settings version this activation replaces (the audit's
      // before-image, with the layout it used).
      const previous =
        (await billTemplateVersionRepository.findActive(tx, {
          kind: "generated",
          familyId,
        })) ??
        (await billTemplateVersionRepository.findDefault(tx, {
          kind: "generated",
          familyId,
        }));

      // bm79 — the pair's layout must still be the row step 3 loaded and
      // checked (the token check already catches a replaced layout; this is
      // the backstop). Retire the previous ACTIVE layout, then promote.
      let layout: {
        promoted: BillTemplateVersion;
        retired: BillTemplateVersion | null;
      } | null = null;
      if (pairLayout) {
        const lockedLayout =
          await billTemplateVersionRepository.findDraftForUpdate(
            tx,
            pairLayout.billTemplateVersionId,
          );
        if (
          !lockedLayout ||
          !pairLayout.checksum ||
          locked.refLayoutVersionId !== pairLayout.billTemplateVersionId ||
          lockedLayout.checksum !== pairLayout.checksum
        ) {
          throw new ActivationRollback("DRAFT_CONFLICT");
        }
        const retiredLayout = await billTemplateVersionRepository.retireActive(
          tx,
          { kind: "layout", familyId },
        );
        const promotedLayout =
          await billTemplateVersionRepository.promoteLayoutDraft(tx, {
            id: pairLayout.billTemplateVersionId,
            expectedChecksum: pairLayout.checksum,
            activatedBy: actorId,
            changeNote,
          });
        if (!promotedLayout) throw new ActivationRollback("DRAFT_CONFLICT");
        layout = { promoted: promotedLayout, retired: retiredLayout };
      }

      // Review fix (§24c) — retire only within the draft's own family, so a
      // second family's ACTIVE version is never touched.
      const retired = await billTemplateVersionRepository.retireActive(tx, {
        kind: "generated",
        familyId,
      });

      const promoted = await billTemplateVersionRepository.promoteDraft(tx, {
        id: draftId,
        expectedToken: expectedDraftToken,
        blobRef,
        checksum: indexDigest,
        checksumAlgorithm: "sha256",
        activatedBy: actorId,
        changeNote,
      });
      if (!promoted) throw new ActivationRollback("DRAFT_CONFLICT");

      await insertAuditEvent(tx, {
        eventType: "INVOICE_TEMPLATE_ACTIVATED",
        actorUserId: actorId,
        targetEntity: "BILL_TEMPLATE_VERSION",
        targetId: promoted.billTemplateVersionId,
        beforeData: {
          activeVersionId: previous?.billTemplateVersionId ?? null,
          activeVersionNo: previous?.versionNo ?? null,
          activeLayoutVersionId: previous?.refLayoutVersionId ?? null,
        },
        afterData: {
          familyId,
          activatedVersionId: promoted.billTemplateVersionId,
          versionNo: promoted.versionNo,
          retiredVersionId: retired?.billTemplateVersionId ?? null,
          changeNote,
          blobRef,
          checksum: indexDigest,
          layout: layout
            ? {
                activatedVersionId: layout.promoted.billTemplateVersionId,
                versionNo: layout.promoted.versionNo,
                retiredVersionId: layout.retired?.billTemplateVersionId ?? null,
                blobRef: layout.promoted.blobRef,
                checksum: layout.promoted.checksum,
              }
            : null,
        },
      });

      return {
        ok: true,
        versionId: promoted.billTemplateVersionId,
        versionNo: promoted.versionNo,
        retiredVersionId: retired?.billTemplateVersionId ?? null,
        blobRef,
        checksum: indexDigest,
        layout: layout
          ? {
              versionId: layout.promoted.billTemplateVersionId,
              versionNo: layout.promoted.versionNo,
              retiredVersionId: layout.retired?.billTemplateVersionId ?? null,
            }
          : null,
      };
    });
  } catch (error) {
    if (error instanceof ActivationRollback) {
      return { ok: false, code: error.code };
    }
    // Any other database error: rolled back, the step-7 blobs stay as orphans.
    throw error;
  }
}
