import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";
import {
  InvoiceRenderError,
  type TemplateDraftErrorCode,
} from "@/types/billing";
import {
  saveTemplateDraftInputSchema,
  type SaveTemplateDraftInput,
} from "@/validation/billing/invoice-template-structure.schema";

// bm57-spec §Design D1–D3 (Inv #44/#46/#49): save the admin's section/column
// choices as the single working DRAFT generated version. No activation, no blob
// write: a DRAFT has no files and is never resolved to render an invoice.
//
// One transaction: advisory lock (serialises draft creation per kind, so two
// concurrent first saves become one insert plus one `DRAFT_CONFLICT`, not a
// unique violation) → re-parse (defense in depth: services assume an
// authorized context, not a valid one) → insert or token-guarded update →
// exactly one `INVOICE_TEMPLATE_DRAFT_SAVED` audit row.
export type SaveTemplateDraftResult =
  | {
      ok: true;
      versionId: string;
      versionNo: number;
      draftToken: string;
    }
  | { ok: false; code: TemplateDraftErrorCode | "VALIDATION_ERROR" };

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  // postgres.js surfaces SQLSTATE on `code`; drizzle may wrap it in `cause`.
  const code =
    (error as { code?: string } | undefined)?.code ??
    (error as { cause?: { code?: string } } | undefined)?.cause?.code;
  return code === UNIQUE_VIOLATION;
}

export async function saveTemplateDraft(
  rawInput: SaveTemplateDraftInput,
  actorId: string,
): Promise<SaveTemplateDraftResult> {
  const parsed = saveTemplateDraftInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const hidden = parsed.error.issues.some(
      (i) => i.message === "MANDATORY_SECTION_HIDDEN",
    );
    return {
      ok: false,
      code: hidden ? "MANDATORY_SECTION_HIDDEN" : "VALIDATION_ERROR",
    };
  }
  const { structure, expectedDraftToken } = parsed.data;

  try {
    return await db.transaction(
      async (tx): Promise<SaveTemplateDraftResult> => {
        // Takes the per-kind advisory lock; the number is used only on insert.
        const nextVersionNo = await billTemplateVersionRepository.nextVersionNo(
          tx,
          { kind: "generated" },
        );
        const draft = await billTemplateVersionRepository.findDraft(tx, {
          kind: "generated",
        });

        if (draft) {
          if (expectedDraftToken !== draft.token) {
            return { ok: false, code: "DRAFT_CONFLICT" };
          }
          const token =
            await billTemplateVersionRepository.updateDraftStructure(tx, {
              id: draft.billTemplateVersionId,
              structure,
              expectedToken: expectedDraftToken,
            });
          if (token === null) return { ok: false, code: "DRAFT_CONFLICT" };

          await insertAuditEvent(tx, {
            eventType: "INVOICE_TEMPLATE_DRAFT_SAVED",
            actorUserId: actorId,
            targetEntity: "BILL_TEMPLATE_VERSION",
            targetId: draft.billTemplateVersionId,
            beforeData: {
              versionNo: draft.versionNo,
              structure: draft.structure,
            },
            afterData: {
              versionNo: draft.versionNo,
              structure,
              refLayoutVersionId: draft.refLayoutVersionId,
            },
          });
          return {
            ok: true,
            versionId: draft.billTemplateVersionId,
            versionNo: draft.versionNo,
            draftToken: token,
          };
        }

        // No draft exists. A client that believed one did is stale.
        if (expectedDraftToken !== null) {
          return { ok: false, code: "DRAFT_CONFLICT" };
        }

        // The draft inherits the layout of the version invoices currently use.
        const current =
          (await billTemplateVersionRepository.findActive(tx, {
            kind: "generated",
          })) ??
          (await billTemplateVersionRepository.findDefault(tx, {
            kind: "generated",
          }));
        if (!current?.refLayoutVersionId) {
          throw new InvoiceRenderError(
            "TEMPLATE_VERSION_NOT_FOUND",
            "no ACTIVE or default generated template version to take a layout from",
            { kind: "generated" },
          );
        }

        const created = await billTemplateVersionRepository.insertDraft(tx, {
          versionNo: nextVersionNo,
          refLayoutVersionId: current.refLayoutVersionId,
          structure,
          createdBy: actorId,
        });
        await insertAuditEvent(tx, {
          eventType: "INVOICE_TEMPLATE_DRAFT_SAVED",
          actorUserId: actorId,
          targetEntity: "BILL_TEMPLATE_VERSION",
          targetId: created.billTemplateVersionId,
          beforeData: null,
          afterData: {
            versionNo: created.versionNo,
            structure,
            refLayoutVersionId: created.refLayoutVersionId,
          },
        });
        return {
          ok: true,
          versionId: created.billTemplateVersionId,
          versionNo: created.versionNo,
          draftToken: created.token,
        };
      },
    );
  } catch (error) {
    // The backstop for a lost race (`btv_one_draft_uq` / `btv_version_uq`).
    if (isUniqueViolation(error)) return { ok: false, code: "DRAFT_CONFLICT" };
    throw error;
  }
}
