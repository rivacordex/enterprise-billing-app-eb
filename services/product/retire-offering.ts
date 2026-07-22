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

// pm16-spec §3.6. One repository call, two possible audit event types —
// "Retire" for a source that was ACTIVE, "Discard" for a source that was
// DRAFT. The initial read below is for fast-path NOT_FOUND rejection only
// (offerings are never hard-deleted, so that result can't go stale); the
// status itself is locked and re-read inside the transaction, immediately
// before eventType is derived and the write happens, since
// `productOfferingRepository.retireOffering` has no status WHERE-backstop
// of its own (code-standards-phase2 §1 rule 11) and status can change
// (e.g. a concurrent activation) between the initial read and this write.
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

  const transitionReason = input.reason || null;

  return db.transaction(async (tx) => {
    const locked = await productOfferingRepository.findLifecycleStatusForUpdate(
      tx,
      offeringId,
    );
    if (!locked) {
      return { ok: false, code: "OFFERING_NOT_FOUND" };
    }
    if (locked.lifecycleStatus === "RETIRED") {
      return { ok: false, code: "OFFERING_RETIRED" };
    }

    const eventType =
      locked.lifecycleStatus === "ACTIVE"
        ? "PRODUCT_OFFERING_RETIRED"
        : "PRODUCT_OFFERING_DISCARDED";

    const { offeringId: retiredId } =
      await productOfferingRepository.retireOffering(tx, offeringId);

    await insertAuditEvent(tx, {
      eventType,
      actorUserId: actorId,
      targetEntity: "PRODUCT_OFFERING",
      targetId: retiredId,
      beforeData: { lifecycleStatus: locked.lifecycleStatus },
      afterData: {
        lifecycleStatus: "RETIRED",
        transitionReason,
      },
    });

    return { ok: true, offeringId: retiredId, eventType };
  });
}
