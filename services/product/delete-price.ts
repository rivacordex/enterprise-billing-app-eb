import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { productOfferingPriceRepository } from "@/db/repositories/product-offering-price";
import { validateOfferingComponents } from "@/services/product/validate-offering-components";
import type { UnitOfMeasure } from "@/types/product";

export type DeletePriceResult =
  | { ok: true; offeringId: string; productOfferingPriceId: string }
  | { ok: false; code: "PRICE_NOT_FOUND" }
  | { ok: false; code: "OFFERING_NOT_DRAFT" }
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

// pm38-spec I4, reshaped by pm49 D4/D9/I4.4. Removes a spare or mistaken
// component from a DRAFT version — never branches (D4); the repository
// refuses a non-DRAFT parent. `productOfferingPriceRepository.deletePrice`
// runs pm49's offering-level validator (as the `validate` callback) strictly
// between its DRAFT lock and the DELETE statement: deleting a base rate out
// from under a `capacity_commitment`/`capacity_motivation` is refused with
// `MODIFIER_WITHOUT_BASE_RATE` before anything is removed. Writes one
// `PRODUCT_PRICE_DELETED` audit event carrying the deleted row in
// `beforeData` (the only surviving record of it), `afterData: null`, in the
// same transaction.
export async function deletePrice(
  priceId: string,
  actorId: string,
): Promise<DeletePriceResult> {
  return db.transaction(async (tx) => {
    const result = await productOfferingPriceRepository.deletePrice(
      tx,
      priceId,
      (offeringId) =>
        validateOfferingComponents(tx, offeringId, {
          kind: "delete",
          productOfferingPriceId: priceId,
        }),
    );
    if (!result.ok) {
      if (result.code === "PRICE_NOT_FOUND") {
        return { ok: false, code: "PRICE_NOT_FOUND" };
      }
      if (result.code === "OFFERING_NOT_DRAFT") {
        return { ok: false, code: "OFFERING_NOT_DRAFT" };
      }
      // One of pm49's three OfferingComponentViolation codes.
      return result;
    }

    await insertAuditEvent(tx, {
      eventType: "PRODUCT_PRICE_DELETED",
      actorUserId: actorId,
      targetEntity: "PRODUCT_OFFERING_PRICE",
      targetId: priceId,
      beforeData: { offeringId: result.offeringId, ...result.before },
      afterData: null,
    });

    return {
      ok: true,
      offeringId: result.offeringId,
      productOfferingPriceId: priceId,
    };
  });
}
