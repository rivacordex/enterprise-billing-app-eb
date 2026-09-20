import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { productInventoryRepository } from "@/db/repositories/inventory/product-inventory.repository";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import type { RetireOfferingInput } from "@/validation/product/retire-offering.schema";

export type RetireOfferingResult =
  | { ok: true; offeringId: string }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_NOT_OBSOLETE" }
  | { ok: false; code: "RETIRE_BLOCKED_BY_SUBSCRIPTIONS"; liveCount: number };

// pm43-spec I4. OBSOLETE → RETIRED, only once no subscription still bills from
// the version (D1). The subscription gate is an in-transaction, cross-module
// precondition re-check, so it calls the inventory repository's locked finder
// directly (never services/inventory/**, code-standards §1.14) — the finder owns
// the live-subscription predicate (D2) and locks the matching rows FOR UPDATE so
// a subscription created mid-transaction is either counted or serialized behind
// this write (D3). Retiring changes nothing but a label: no row is deleted, no
// price is touched, no subscription is repointed (D5, Inv. #26). Writes one audit
// event carrying the observed live count (zero, recorded as evidence).
export async function retireOffering(
  offeringId: string,
  input: RetireOfferingInput,
  actorId: string,
): Promise<RetireOfferingResult> {
  const transitionReason = input.reason || null;

  return db.transaction(async (tx) => {
    const locked = await productOfferingRepository.findLifecycleStatusForUpdate(
      tx,
      offeringId,
    );
    if (!locked) {
      return { ok: false, code: "OFFERING_NOT_FOUND" };
    }
    if (locked.lifecycleStatus !== "OBSOLETE") {
      return { ok: false, code: "OFFERING_NOT_OBSOLETE" };
    }

    const liveCount =
      await productInventoryRepository.countLiveForOfferingForUpdate(
        tx,
        offeringId,
      );
    if (liveCount > 0) {
      return {
        ok: false,
        code: "RETIRE_BLOCKED_BY_SUBSCRIPTIONS",
        liveCount,
      };
    }

    await productOfferingRepository.retireOffering(tx, offeringId, actorId);

    await insertAuditEvent(tx, {
      eventType: "PRODUCT_OFFERING_RETIRED",
      actorUserId: actorId,
      targetEntity: "PRODUCT_OFFERING",
      targetId: offeringId,
      beforeData: { lifecycleStatus: "OBSOLETE" },
      afterData: {
        lifecycleStatus: "RETIRED",
        transitionReason,
        liveSubscriptionCount: liveCount,
      },
    });

    return { ok: true, offeringId };
  });
}
