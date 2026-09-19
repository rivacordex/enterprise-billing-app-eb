import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { productOfferingPriceRepository } from "@/db/repositories/product-offering-price";

export type DeletePriceResult =
  | { ok: true; offeringId: string; productOfferingPriceId: string }
  | { ok: false; code: "PRICE_NOT_FOUND" }
  | { ok: false; code: "OFFERING_NOT_DRAFT" };

// pm38-spec I4. Removes a spare or mistaken price from a DRAFT version — never
// branches (D4); the repository refuses a non-DRAFT parent. Writes one
// `PRODUCT_PRICE_DELETED` audit event carrying the deleted row in `beforeData`
// (the only surviving record of it), `afterData: null`, in the same transaction.
export async function deletePrice(
  priceId: string,
  actorId: string,
): Promise<DeletePriceResult> {
  return db.transaction(async (tx) => {
    const result = await productOfferingPriceRepository.deletePrice(
      tx,
      priceId,
    );
    if (!result.ok) {
      return result.code === "PRICE_NOT_FOUND"
        ? { ok: false, code: "PRICE_NOT_FOUND" }
        : { ok: false, code: "OFFERING_NOT_DRAFT" };
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
