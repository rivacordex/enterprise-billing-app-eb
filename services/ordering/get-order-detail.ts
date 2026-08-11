import { db } from "@/db/client";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import { productOfferingPriceRepository } from "@/db/repositories/product-offering-price";
import { orderItemPriceOverrideRepository } from "@/db/repositories/ordering/order-item-price-override.repository";
import { productOrderItemRepository } from "@/db/repositories/ordering/product-order-item.repository";
import { productOrderRepository } from "@/db/repositories/ordering/product-order.repository";
import type { OrderDetail, OrderPriceLine } from "@/types/ordering";

// A catalog price row is effective on `now` when its window `[start,
// successorStart)` contains `now` — start already reached, no successor yet
// reached (mirrors get-offering-detail's `resolveEffectivityStatus`, whose
// original is private to that module). A future-dated successor never displaces
// the current row early.
function isEffectiveNow(
  startDateTime: Date,
  endDateTime: Date | null,
  now: Date,
): boolean {
  if (startDateTime > now) return false;
  if (endDateTime !== null && endDateTime <= now) return false;
  return true;
}

// Backs the order detail view. Assembles header + item + the resolved
// `OrderPriceLine[]` (Inv. #16 override-else-catalog, computed once here for
// every consumer). Prices resolve from the pinned offering version's immutable
// catalog rows effective on `now` — no ACTIVE filter, so a grandfathered
// RETIRED version still reads (Inv. #17). Returns `null` for an unknown order
// (general §2.9 — no throw for expected control flow).
export async function getOrderDetail(
  productOrderId: string,
  now: Date = new Date(),
): Promise<OrderDetail | null> {
  const order = await productOrderRepository.findById(db, productOrderId);
  if (!order) return null;

  const items = await productOrderItemRepository.findByOrderId(
    db,
    productOrderId,
  );
  const item = items[0];
  // A well-formed order always has its (single) item; treat a headerless-item
  // order as not-found rather than throwing.
  if (!item) return null;

  const [offering, overrides, priceRows] = await Promise.all([
    productOfferingRepository.findDetailById(db, item.productOfferingId),
    orderItemPriceOverrideRepository.findByItemId(db, item.productOrderItemId),
    productOfferingPriceRepository.findByOfferingIdWithDerivedEnd(
      db,
      item.productOfferingId,
    ),
  ]);
  if (!offering) return null;

  const overrideByType = new Map(
    overrides.map((o) => [o.priceType, o.amount] as const),
  );

  // One line per price_type effective today, catalog list amount as the base,
  // the override (flat types only) layered on top. Ordered by price_type for a
  // stable read (the catalog query already returns price_type-major order).
  const prices: OrderPriceLine[] = priceRows
    .filter((row) => isEffectiveNow(row.startDateTime, row.endDateTime, now))
    .map((row) => {
      const overrideAmount = overrideByType.get(row.priceType) ?? null;
      return {
        priceType: row.priceType,
        priceName: row.name,
        listAmount: row.amount,
        currency: row.currency,
        overrideAmount,
        effectiveAmount: overrideAmount ?? row.amount,
      };
    });

  return {
    productOrderId: order.productOrderId,
    customerPartyRoleId: order.customerPartyRoleId,
    billingAccountId: order.billingAccountId,
    status: order.status,
    failureReason: order.failureReason,
    submittedBy: order.submittedBy,
    submittedAt: order.submittedAt,
    reviewedBy: order.reviewedBy,
    reviewedAt: order.reviewedAt,
    completedAt: order.completedAt,
    item: {
      productOrderItemId: item.productOrderItemId,
      productOfferingId: item.productOfferingId,
      offeringName: offering.name,
      offeringVersion: offering.version,
      quantity: item.quantity,
      startDate: item.startDate,
      orderedCharacteristics: item.orderedCharacteristics ?? null,
    },
    prices,
  };
}
