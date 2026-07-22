import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import { productOfferingPriceRepository } from "@/db/repositories/product-offering-price";
import { productSpecificationRepository } from "@/db/repositories/product-specification";
import type { ActivateOfferingInput } from "@/validation/product/activate-offering.schema";

export type ActivateOfferingResult =
  | { ok: true; offeringId: string; supersededOfferingId: string | null }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_NOT_DRAFT" }
  | { ok: false; code: "NO_PRICE_ROWS" }
  | { ok: false; code: "SPECIFICATIONS_NOT_RESOLVED" };

// pm16-spec §3.5. Preconditions are read ahead of the transaction (Design)
// — a specification or price row disappearing between this check and the
// commit is a disclosed, unlocked gap, unlike Inv. 13's single-active-per-
// family invariant, which the transaction itself (via
// productOfferingRepository.activateOffering) re-checks with a row lock.
export async function activateOffering(
  offeringId: string,
  input: ActivateOfferingInput,
  actorId: string,
): Promise<ActivateOfferingResult> {
  const offering = await productOfferingRepository.findDetailById(
    db,
    offeringId,
  );
  if (!offering) {
    return { ok: false, code: "OFFERING_NOT_FOUND" };
  }
  if (offering.lifecycleStatus !== "DRAFT") {
    return { ok: false, code: "OFFERING_NOT_DRAFT" };
  }

  const prices =
    await productOfferingPriceRepository.findByOfferingIdWithDerivedEnd(
      db,
      offeringId,
    );
  if (prices.length === 0) {
    return { ok: false, code: "NO_PRICE_ROWS" };
  }

  // Decision 5's literal rule: at least one specification exists, AND every
  // mandatory one has a resolved (non-null) defaultValue (Design).
  const specs = await productSpecificationRepository.findByOfferingId(
    db,
    offeringId,
  );
  const specificationsResolved =
    specs.length > 0 &&
    specs.every((spec) => !spec.isMandatory || spec.defaultValue !== null);
  if (!specificationsResolved) {
    return { ok: false, code: "SPECIFICATIONS_NOT_RESOLVED" };
  }

  const transitionReason = input.reason || null;

  return db.transaction(async (tx) => {
    const { offeringId: activatedId, supersededOfferingId } =
      await productOfferingRepository.activateOffering(tx, offeringId);

    if (supersededOfferingId) {
      await insertAuditEvent(tx, {
        eventType: "PRODUCT_OFFERING_SUPERSEDED",
        actorUserId: actorId,
        targetEntity: "PRODUCT_OFFERING",
        targetId: supersededOfferingId,
        beforeData: { lifecycleStatus: "ACTIVE" },
        afterData: {
          lifecycleStatus: "RETIRED",
          supersededByOfferingId: activatedId,
        },
      });
    }

    await insertAuditEvent(tx, {
      eventType: "PRODUCT_OFFERING_ACTIVATED",
      actorUserId: actorId,
      targetEntity: "PRODUCT_OFFERING",
      targetId: activatedId,
      beforeData: { lifecycleStatus: "DRAFT" },
      afterData: {
        lifecycleStatus: "ACTIVE",
        transitionReason,
      },
    });

    return {
      ok: true,
      offeringId: activatedId,
      supersededOfferingId,
    };
  });
}
