import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import type { TransitionInput } from "@/validation/product/transition.schema";

export type ReturnToDraftResult =
  | { ok: true; offeringId: string }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_NOT_TESTING" };

// pm42-spec I3. TESTING → DRAFT, and nothing else (pm42 D4): no content is
// restored, no version created, no audit rewrite. The version becomes editable
// again because the §3.5 trigger's DRAFT condition is satisfied once more. It is
// reachable only from TESTING — an ACTIVE version never returns to draft
// (Inv. #23). Status is re-read locked, on `tx`, immediately before the write
// (code-standards §1.13).
export async function returnToDraft(
  offeringId: string,
  input: TransitionInput,
  actorId: string,
): Promise<ReturnToDraftResult> {
  const transitionReason = input.reason || null;

  return db.transaction(async (tx) => {
    const locked = await productOfferingRepository.findLifecycleStatusForUpdate(
      tx,
      offeringId,
    );
    if (!locked) {
      return { ok: false, code: "OFFERING_NOT_FOUND" };
    }
    if (locked.lifecycleStatus !== "TESTING") {
      return { ok: false, code: "OFFERING_NOT_TESTING" };
    }

    await productOfferingRepository.markDraft(tx, offeringId, actorId);

    await insertAuditEvent(tx, {
      eventType: "PRODUCT_OFFERING_RETURNED_TO_DRAFT",
      actorUserId: actorId,
      targetEntity: "PRODUCT_OFFERING",
      targetId: offeringId,
      beforeData: { lifecycleStatus: "TESTING" },
      afterData: {
        lifecycleStatus: "DRAFT",
        transitionReason,
      },
    });

    return { ok: true, offeringId };
  });
}
