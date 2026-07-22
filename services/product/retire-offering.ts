import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import type { RetireOfferingInput } from "@/validation/product/retire-offering.schema";

export type RetireOfferingResult =
  | {
      ok: true;
      offeringId: string;
      eventType: "PRODUCT_OFFERING_RETIRED" | "PRODUCT_OFFERING_DISCARDED";
    }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_RETIRED" };

// pm16-spec §3.6. One repository call, two possible audit event types,
// chosen from the offering's status as read before the transaction opens
// (Design; code-standards-phase2 §1 rule 11) — "Retire" for a source that
// was ACTIVE, "Discard" for a source that was DRAFT.
export async function retireOffering(
  offeringId: string,
  input: RetireOfferingInput,
  actorId: string,
): Promise<RetireOfferingResult> {
  const offering = await productOfferingRepository.findDetailById(
    db,
    offeringId,
  );
  if (!offering) {
    return { ok: false, code: "OFFERING_NOT_FOUND" };
  }
  if (offering.lifecycleStatus === "RETIRED") {
    return { ok: false, code: "OFFERING_RETIRED" };
  }

  const eventType =
    offering.lifecycleStatus === "ACTIVE"
      ? "PRODUCT_OFFERING_RETIRED"
      : "PRODUCT_OFFERING_DISCARDED";
  const transitionReason = input.reason || null;

  return db.transaction(async (tx) => {
    const { offeringId: retiredId } =
      await productOfferingRepository.retireOffering(tx, offeringId);

    await insertAuditEvent(tx, {
      eventType,
      actorUserId: actorId,
      targetEntity: "PRODUCT_OFFERING",
      targetId: retiredId,
      beforeData: { lifecycleStatus: offering.lifecycleStatus },
      afterData: {
        lifecycleStatus: "RETIRED",
        transitionReason,
      },
    });

    return { ok: true, offeringId: retiredId, eventType };
  });
}
