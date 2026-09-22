import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import {
  productOfferingPriceRepository,
  toPriceWriteData,
} from "@/db/repositories/product-offering-price";
import { isUniqueViolation } from "@/lib/db-errors";
import {
  validateOfferingComponents,
  type ValidateOfferingComponentsResult,
} from "@/services/product/validate-offering-components";
import type { UnitOfMeasure } from "@/types/product";
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
  | { ok: false; code: "BACKDATED_START_TOO_FAR" }
  | { ok: false; code: "DUPLICATE_START" }
  | {
      ok: false;
      code: "MODIFIER_WITHOUT_BASE_RATE";
      unitOfMeasure: UnitOfMeasure;
    }
  | { ok: false; code: "AMBIGUOUS_BASE_RATE" }
  | {
      ok: false;
      code: "CURRENCY_MISMATCH";
      existingCurrency: string;
      candidateCurrency: string;
    };

// Carries a component-validator refusal out of the transaction so it can be
// turned into a typed result rather than committing a partial write. Needed
// because insertPrice may have already branched a new DRAFT (a real write)
// before the validator runs (pm49-spec D9) — a plain early `return` would
// commit that branch even though the price it was for was refused, so
// refusal here must THROW to roll the whole transaction back, mirroring
// update-price.ts's own `BackdatedStartTooFarError` sentinel.
class OfferingComponentViolationError extends Error {
  constructor(
    public readonly result: Exclude<
      ValidateOfferingComponentsResult,
      { ok: true }
    >,
  ) {
    super(`offering component violation: ${result.code}`);
  }
}

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

  // pm49-spec I1.2 (carrying forward pm38-spec I4's intent) — the component
  // envelope and the per-component-type completeness columns come from the
  // parsed discriminated input, shared with updatePrice via toPriceWriteData
  // so the two writes can never disagree on which columns each type fills.
  const priceData = toPriceWriteData(input);

  try {
    return await db.transaction(async (tx) => {
      // Re-fetched through tx, immediately before the branch decision (post-
      // ship fix) — a pre-transaction read via `db` would let the offering's
      // lifecycleStatus go stale between this read and the write below.
      const offering = await productOfferingRepository.findDetailByIdForUpdate(
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

      // pm49-spec D9/I4.2 — the validator runs against the branched draft's
      // component set, not the source version's: the branch happens
      // mid-transaction and the offering id changes underneath it.
      const validation = await validateOfferingComponents(
        tx,
        targetOfferingId,
        {
          kind: "insert",
          componentType: priceData.componentType,
          unitOfMeasure: priceData.unitOfMeasure,
          currency: priceData.currency,
          startDateTime: priceData.startDateTime,
        },
      );
      if (!validation.ok) {
        throw new OfferingComponentViolationError(validation);
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
  } catch (err) {
    if (err instanceof OfferingComponentViolationError) {
      return err.result;
    }
    // A second component of the same type/unit at the same start on this
    // offering hits the UNIQUE (offering, component_type, unit_of_measure,
    // start_date_time) constraint (Inv. #2) — the same collision updatePrice
    // translates, surfaced here as a typed result instead of a raw error
    // (pm38 review symmetry fix). Renamed with pm46's constraint rekey.
    if (
      isUniqueViolation(err, "product_offering_price_component_start_unique")
    ) {
      return { ok: false, code: "DUPLICATE_START" };
    }
    throw err; // anything else is a genuine, unexpected failure — fail loud
  }
}
