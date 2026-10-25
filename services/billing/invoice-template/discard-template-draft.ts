import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { billTemplateFamilyRepository } from "@/db/repositories/billing/bill-template-family";
import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";
import type { DiscardTemplateDraftResult } from "@/types/billing";

// bm79 — a type's DRAFTs → RETIRED (rows and numbers are never reused; blobs
// stay, write-once and never deleted inline). Same lock order as install and
// activate: the type row, then the kind (Inv #66). The input is the settings
// DRAFT the page shows and its token, so a discard after an unseen upload (which
// re-points the settings DRAFT and bumps its token) is DRAFT_CONFLICT. A layout
// DRAFT without a settings DRAFT cannot arise in the app: install always
// creates or re-points one.

type DiscardFailureCode = Extract<
  DiscardTemplateDraftResult,
  { ok: false }
>["code"];

// Thrown inside the transaction to roll it back, then mapped to a result
// outside (a returned value would COMMIT).
class DiscardRollback extends Error {
  constructor(readonly code: DiscardFailureCode) {
    super(code);
  }
}

export async function discardTemplateDraft(
  input: { familyId: string; draftId: string; expectedDraftToken: string },
  actorId: string,
): Promise<DiscardTemplateDraftResult> {
  const { familyId, draftId, expectedDraftToken } = input;
  try {
    return await db.transaction(
      async (tx): Promise<DiscardTemplateDraftResult> => {
        const type = await billTemplateFamilyRepository.lockTemplateType(
          tx,
          familyId,
          "update",
        );
        if (!type) throw new DiscardRollback("VALIDATION_ERROR");
        // Inv #67 — a retired type's DRAFTs stay as retire left them.
        if (type.retiredDatetime !== null) {
          throw new DiscardRollback("TEMPLATE_TYPE_RETIRED");
        }
        await billTemplateVersionRepository.lockKind(tx, { kind: "generated" });

        const settings = await billTemplateVersionRepository.findDraftForUpdate(
          tx,
          draftId,
        );
        if (
          !settings ||
          settings.kind !== "generated" ||
          settings.refBillTemplateFamilyId !== familyId ||
          settings.token !== expectedDraftToken
        ) {
          throw new DiscardRollback("DRAFT_CONFLICT");
        }

        const layoutDraft = await billTemplateVersionRepository.findDraft(tx, {
          kind: "layout",
          familyId,
        });

        // Settings first, then the layout DRAFT it may point at.
        const discarded = [settings, ...(layoutDraft ? [layoutDraft] : [])];
        for (const row of discarded) {
          const done = await billTemplateVersionRepository.discardDraft(tx, {
            id: row.billTemplateVersionId,
            actorId,
          });
          if (!done) throw new DiscardRollback("DRAFT_CONFLICT");
        }

        await insertAuditEvent(tx, {
          eventType: "INVOICE_TEMPLATE_DRAFT_DISCARDED",
          actorUserId: actorId,
          targetEntity: "BILL_TEMPLATE_VERSION",
          targetId: settings.billTemplateVersionId,
          beforeData: { status: "DRAFT" },
          afterData: {
            familyId,
            settingsVersionId: settings.billTemplateVersionId,
            settingsVersionNo: settings.versionNo,
            layoutVersionId: layoutDraft?.billTemplateVersionId ?? null,
            layoutVersionNo: layoutDraft?.versionNo ?? null,
          },
        });

        return {
          ok: true,
          discardedVersionIds: discarded.map((r) => r.billTemplateVersionId),
        };
      },
    );
  } catch (error) {
    if (error instanceof DiscardRollback) {
      return { ok: false, code: error.code };
    }
    throw error;
  }
}
