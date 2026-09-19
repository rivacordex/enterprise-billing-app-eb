import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import {
  productOfferingPriceRepository,
  toPriceWriteData,
} from "@/db/repositories/product-offering-price";
import { isUniqueViolation } from "@/lib/db-errors";
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
  | { ok: false; code: "DUPLICATE_START" };

// pm38-spec I4. Corrects a price on a DRAFT version — never branches (D4): a
// request to change a specific existing price row on a released version is not a
// request to create a new one, so the repository refuses a non-DRAFT parent
// (`OFFERING_NOT_DRAFT`) and the UI tells the user to edit the open draft
// instead. `now` defaults to the real clock but is injectable for deterministic
// tests, mirroring insert-price.ts. Same authoritative, transaction-adjacent
// backdating check as insertPrice — declared against `THREE_DAYS_MS`, the
// single module-local tolerance source (I2).
export async function updatePrice(
  priceId: string,
  input: UpdatePriceInput,
  actorId: string,
  now: Date = new Date(),
): Promise<UpdatePriceResult> {
  const msSinceStart = now.getTime() - input.startDateTime.getTime();
  const backdated = msSinceStart > 0;
  if (msSinceStart > THREE_DAYS_MS) {
    return { ok: false, code: "BACKDATED_START_TOO_FAR" };
  }

  // Shared with insertPrice (toPriceWriteData) so both writes apply the same
  // per-price-type completeness projection — no divergence risk (pm38-spec I4).
  const data = toPriceWriteData(input);

  try {
    return await db.transaction(async (tx) => {
      const result = await productOfferingPriceRepository.updatePrice(
        tx,
        priceId,
        data,
      );
      if (!result.ok) {
        return result.code === "PRICE_NOT_FOUND"
          ? { ok: false, code: "PRICE_NOT_FOUND" }
          : { ok: false, code: "OFFERING_NOT_DRAFT" };
      }

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
    // The UNIQUE (offering, price_type, start_date_time) index (Inv. #2) keeps
    // the derived-effectivity window well defined; a colliding edit surfaces as
    // a typed result, not a raw database error (pm38-spec I4).
    if (isUniqueViolation(err, "product_offering_price_type_start_unique")) {
      return { ok: false, code: "DUPLICATE_START" };
    }
    throw err; // anything else is a genuine, unexpected failure — fail loud
  }
}
