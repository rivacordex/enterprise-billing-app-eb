import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import { productOfferingPriceRepository } from "@/db/repositories/product-offering-price";
import type { InsertPriceInput } from "@/validation/product/insert-price.schema";

// Same tolerance value as insert-price.schema.ts's own copy — declared
// independently, not imported, per Design's duplication note.
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

export type InsertPriceResult =
  | {
      ok: true;
      offeringId: string;
      productOfferingPriceId: string;
      branched: boolean;
      backdated: boolean;
    }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_RETIRED" }
  | { ok: false; code: "BACKDATED_START_TOO_FAR" };

// pm15-spec §3.4. Branch-first when the target offering is ACTIVE (Design);
// adding a price never needs to "locate a counterpart" the way pm14's
// update/delete methods do, since it is new content, not an action against
// existing content. `now` defaults to the real clock but is injectable for
// deterministic tests, mirroring services/product/get-offering-detail.ts's
// own `now: Date = new Date()` convention.
export async function insertPrice(
  offeringId: string,
  input: InsertPriceInput,
  actorId: string,
  now: Date = new Date(),
): Promise<InsertPriceResult> {
  // Authoritative backdating check (Design) — against this call's own
  // `now`, not whatever `Date.now()` returned when the schema's superRefine
  // ran at parse time. Checked ahead of the transaction (no offering read
  // needed) so an out-of-tolerance request never opens one.
  const msSinceStart = now.getTime() - input.startDateTime.getTime();
  const backdated = msSinceStart > 0;
  if (msSinceStart > THREE_DAYS_MS) {
    return { ok: false, code: "BACKDATED_START_TOO_FAR" };
  }

  const priceData = {
    name: input.name,
    priceType: input.priceType,
    currency: input.currency,
    glCode: input.glCode,
    pricingModel: input.priceCharacteristics.pricing_model,
    amount: input.priceCharacteristics.amount,
    pricingCharacteristics: input.priceCharacteristics.pricing_characteristics,
    startDateTime: input.startDateTime,
  };

  return db.transaction(async (tx) => {
    // Re-fetched through tx, immediately before the branch decision (post-
    // ship fix) — a pre-transaction read via `db` would let the offering's
    // lifecycleStatus go stale between this read and the write below.
    const offering = await productOfferingRepository.findDetailById(
      tx,
      offeringId,
    );
    if (!offering) {
      return { ok: false, code: "OFFERING_NOT_FOUND" };
    }
    if (offering.lifecycleStatus === "RETIRED") {
      return { ok: false, code: "OFFERING_RETIRED" };
    }

    let targetOfferingId = offeringId;
    let branched = false;

    if (offering.lifecycleStatus === "ACTIVE") {
      const { offeringId: branchedId } =
        await productOfferingRepository.branchOfferingAsDraft(tx, offeringId);
      targetOfferingId = branchedId;
      branched = true;
    }

    const { productOfferingPriceId } =
      await productOfferingPriceRepository.insertPrice(tx, {
        productOfferingId: targetOfferingId,
        ...priceData,
      });

    await insertAuditEvent(tx, {
      eventType: "PRODUCT_PRICE_ADDED",
      actorUserId: actorId,
      targetEntity: "PRODUCT_OFFERING_PRICE",
      targetId: productOfferingPriceId,
      beforeData: null,
      afterData: {
        offeringId: targetOfferingId,
        ...(branched ? { branchedFromOfferingId: offeringId } : {}),
        ...priceData,
        backdated,
      },
    });

    return {
      ok: true,
      offeringId: targetOfferingId,
      productOfferingPriceId,
      branched,
      backdated,
    };
  });
}
