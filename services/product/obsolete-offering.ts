import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import type { TransitionInput } from "@/validation/product/transition.schema";

export type ObsoleteOfferingResult =
  | { ok: true; offeringId: string }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_NOT_ACTIVE" };

// pm43-spec I3. ACTIVE → OBSOLETE (stop selling) — withdraw a live version from
// sale without a replacement. Same OBSOLETE status an activation supersedes into
// (pm42 D3): not orderable, still a full billing source for its pinned
// subscriptions (Inv. #6/#17). No family lock is needed: leaving the active slot
// empty cannot violate either family index (D1/I3). Status is re-read locked, on
// `tx`, immediately before the write (code-standards §1.13).
export async function obsoleteOffering(
  offeringId: string,
  input: TransitionInput,
  actorId: string,
): Promise<ObsoleteOfferingResult> {
  const transitionReason = input.reason || null;

  return db.transaction(async (tx) => {
    const locked = await productOfferingRepository.findLifecycleStatusForUpdate(
      tx,
      offeringId,
    );
    if (!locked) {
      return { ok: false, code: "OFFERING_NOT_FOUND" };
    }
    if (locked.lifecycleStatus !== "ACTIVE") {
      return { ok: false, code: "OFFERING_NOT_ACTIVE" };
    }

    await productOfferingRepository.markObsolete(tx, offeringId, actorId);

    await insertAuditEvent(tx, {
      eventType: "PRODUCT_OFFERING_OBSOLETED",
      actorUserId: actorId,
      targetEntity: "PRODUCT_OFFERING",
      targetId: offeringId,
      beforeData: { lifecycleStatus: "ACTIVE" },
      afterData: {
        lifecycleStatus: "OBSOLETE",
        transitionReason,
      },
    });

    return { ok: true, offeringId };
  });
}
