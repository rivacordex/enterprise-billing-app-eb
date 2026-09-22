import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import {
  productOfferingPriceRepository,
  toPriceWriteData,
} from "@/db/repositories/product-offering-price";
import { isUniqueViolation } from "@/lib/db-errors";
import { validateOfferingComponents } from "@/services/product/validate-offering-components";
import type { UnitOfMeasure } from "@/types/product";
import { THREE_DAYS_MS } from "@/validation/product/insert-price.schema";
import type { UpdatePriceInput } from "@/validation/product/update-price.schema";

export type UpdatePriceResult =
  | {
      ok: true;
      offeringId: string;
      productOfferingPriceId: string;
      backdated: boolean;
    }
  | { ok: false; code: "PRICE_NOT_FOUND" }
  | { ok: false; code: "OFFERING_NOT_DRAFT" }
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

// Sentinel that rolls the in-transaction update back when the *changed* start
// date is out of tolerance (see below). Kept internal — never leaks past the
// catch, which maps it to the typed BACKDATED_START_TOO_FAR result.
class BackdatedStartTooFarError extends Error {}

// pm38-spec I4, amended pm41 review #1, reshaped by pm49. Corrects a
// component on a DRAFT version — never branches (D4): a request to change a
// specific existing price row on a released version is not a request to
// create a new one, so the repository refuses a non-DRAFT parent
// (`OFFERING_NOT_DRAFT`) and the UI tells the user to edit the open draft
// instead. `now` defaults to the real clock but is injectable for
// deterministic tests, mirroring insert-price.ts.
//
// pm49-spec I4.2/§2.14 — `productOfferingPriceRepository.updatePrice` calls
// `validateOfferingComponents` (passed in as the `validate` callback) strictly
// between its own DRAFT lock and the actual UPDATE statement, so a VI3–VI5
// refusal commits nothing (D6 — the DRAFT gate and the cross-row validator
// each stay in their one home).
//
// The 3-day backdating tolerance applies **only when the start date actually
// changes** (pm41 review #1). A re-save that leaves the start untouched — e.g.
// fixing an amount on a draft branched from an ACTIVE version whose prices
// started months ago — must not be blocked by the row's own already-accepted
// start date; otherwise the panel's whole reason to exist ("fix a wrong price
// on a draft") is unreachable. A start *moved* more than 3 days into the past is
// still rejected. The stored start is only known inside the transaction (the
// repository reads it under the parent lock), so the check runs there and rolls
// the just-applied update back by throwing when it fails.
export async function updatePrice(
  priceId: string,
  input: UpdatePriceInput,
  actorId: string,
  now: Date = new Date(),
): Promise<UpdatePriceResult> {
  // Shared with insertPrice (toPriceWriteData) so both writes apply the same
  // per-component-type completeness projection — no divergence risk
  // (pm38-spec I4, carried forward by pm49-spec I1.2).
  const data = toPriceWriteData(input);

  try {
    return await db.transaction(async (tx) => {
      const result = await productOfferingPriceRepository.updatePrice(
        tx,
        priceId,
        data,
        (offeringId) =>
          validateOfferingComponents(tx, offeringId, {
            kind: "update",
            productOfferingPriceId: priceId,
            componentType: data.componentType,
            unitOfMeasure: data.unitOfMeasure,
            currency: data.currency,
            startDateTime: data.startDateTime,
          }),
      );
      if (!result.ok) {
        if (result.code === "PRICE_NOT_FOUND") {
          return { ok: false, code: "PRICE_NOT_FOUND" };
        }
        if (result.code === "OFFERING_NOT_DRAFT") {
          return { ok: false, code: "OFFERING_NOT_DRAFT" };
        }
        // One of pm49's three OfferingComponentViolation codes — already
        // shaped exactly like this function's own result union.
        return result;
      }

      const startChanged =
        result.before.startDateTime.getTime() !== input.startDateTime.getTime();
      const msSinceStart = now.getTime() - input.startDateTime.getTime();
      if (startChanged && msSinceStart > THREE_DAYS_MS) {
        throw new BackdatedStartTooFarError();
      }
      const backdated = msSinceStart > 0;

      await insertAuditEvent(tx, {
        eventType: "PRODUCT_PRICE_UPDATED",
        actorUserId: actorId,
        targetEntity: "PRODUCT_OFFERING_PRICE",
        targetId: priceId,
        beforeData: { offeringId: result.offeringId, ...result.before },
        afterData: {
          offeringId: result.offeringId,
          ...result.after,
          backdated,
        },
      });

      return {
        ok: true,
        offeringId: result.offeringId,
        productOfferingPriceId: priceId,
        backdated,
      };
    });
  } catch (err) {
    if (err instanceof BackdatedStartTooFarError) {
      return { ok: false, code: "BACKDATED_START_TOO_FAR" };
    }
    // The UNIQUE (offering, component_type, unit_of_measure, start_date_time)
    // constraint (Inv. #2) keeps the derived-effectivity window well defined;
    // a colliding edit surfaces as a typed result, not a raw database error
    // (pm38-spec I4). Renamed with pm46's constraint rekey.
    if (
      isUniqueViolation(err, "product_offering_price_component_start_unique")
    ) {
      return { ok: false, code: "DUPLICATE_START" };
    }
    throw err; // anything else is a genuine, unexpected failure — fail loud
  }
}
