import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import { productOfferingPriceRepository } from "@/db/repositories/product-offering-price";
import { productSpecificationRepository } from "@/db/repositories/product-specification";
import type { TransitionInput } from "@/validation/product/transition.schema";

export type SubmitForTestingResult =
  | { ok: true; offeringId: string }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_NOT_DRAFT" }
  | { ok: false; code: "NO_PRICE_ROWS" }
  | { ok: false; code: "SPECIFICATIONS_NOT_RESOLVED" };

// pm42-spec I2. DRAFT → TESTING. The release preconditions live here, one step
// earlier than they used to sit at activation (pm42 D2): at least one price row,
// at least one specification, and every mandatory specification carrying a
// non-null defaultValue. These are the old activation checks verbatim, relocated
// — they are the reason TESTING → ACTIVE can re-check nothing about content.
// Every read that gates the write happens inside the transaction, locked,
// immediately before `markTesting` (code-standards §1.13).
export async function submitForTesting(
  offeringId: string,
  input: TransitionInput,
  actorId: string,
): Promise<SubmitForTestingResult> {
  const transitionReason = input.reason || null;

  return db.transaction(async (tx) => {
    const locked = await productOfferingRepository.findLifecycleStatusForUpdate(
      tx,
      offeringId,
    );
    if (!locked) {
      return { ok: false, code: "OFFERING_NOT_FOUND" };
    }
    if (locked.lifecycleStatus !== "DRAFT") {
      return { ok: false, code: "OFFERING_NOT_DRAFT" };
    }

    const prices =
      await productOfferingPriceRepository.findByOfferingIdWithDerivedEnd(
        tx,
        offeringId,
      );
    if (prices.length === 0) {
      return { ok: false, code: "NO_PRICE_ROWS" };
    }

    // Decision 5's literal rule: at least one specification exists, AND every
    // mandatory one has a resolved (non-null) defaultValue. Read locked, so a
    // concurrent spec edit cannot slip the version into TESTING with an
    // unresolved mandatory spec.
    const specs =
      await productSpecificationRepository.findByOfferingIdForUpdate(
        tx,
        offeringId,
      );
    const specificationsResolved =
      specs.length > 0 &&
      specs.every((spec) => !spec.isMandatory || spec.defaultValue !== null);
    if (!specificationsResolved) {
      return { ok: false, code: "SPECIFICATIONS_NOT_RESOLVED" };
    }

    await productOfferingRepository.markTesting(tx, offeringId, actorId);

    await insertAuditEvent(tx, {
      eventType: "PRODUCT_OFFERING_SUBMITTED_FOR_TESTING",
      actorUserId: actorId,
      targetEntity: "PRODUCT_OFFERING",
      targetId: offeringId,
      beforeData: { lifecycleStatus: "DRAFT" },
      afterData: {
        lifecycleStatus: "TESTING",
        transitionReason,
      },
    });

    return { ok: true, offeringId };
  });
}
