import { db } from "@/db/client";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import { productOfferingPriceRepository } from "@/db/repositories/product-offering-price";
import { orderItemPriceOverrideRepository } from "@/db/repositories/ordering/order-item-price-override.repository";
import { productOrderItemRepository } from "@/db/repositories/ordering/product-order-item.repository";
import { productOrderRepository } from "@/db/repositories/ordering/product-order.repository";
import type {
  OrderDetail,
  OrderPriceLine,
  OverridePriceType,
} from "@/types/ordering";
import type { PricingComponent } from "@/types/product";

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

// Maps a catalog component to the override price-type axis and its scalar list
// amount, or `null` when the component is not an order price line at all — the
// `capacity_*` modifiers are never an override target and carry no scalar list
// amount (pm50 D2). This is the inverse of pm50's OVERRIDE_TARGET_BY_PRICE_TYPE
// in order-preconditions.ts; the two axes stay explicitly separate (Inv. #38),
// `once` never equated with the envelope's `oneTime`.
function toPricedComponent(
  component: PricingComponent,
): { priceType: OverridePriceType; listAmount: string } | null {
  switch (component["@type"]) {
    case "usage_rate":
      return { priceType: "usage", listAmount: component.params.ratePerUnit };
    case "flat_fee":
      return {
        priceType: component.priceType === "recurring" ? "recurring" : "once",
        listAmount: component.params.amount,
      };
    default:
      return null; // capacity_commitment / capacity_motivation
  }
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

  // One line per override-eligible component effective today, the envelope's own
  // money as the list amount and the override layered on top (Inv. #16). Each
  // component maps to the override price-type axis via `toPricedComponent` — the
  // `capacity_*` modifiers map to nothing and are dropped (not order lines).
  // Ordered by the catalog query's (component_type, unit_of_measure, start) key
  // for a stable read.
  const prices: OrderPriceLine[] = priceRows
    .filter((row) => isEffectiveNow(row.startDateTime, row.endDateTime, now))
    .flatMap((row) => {
      const priced = toPricedComponent(row.component);
      if (!priced) return [];
      const overrideAmount = overrideByType.get(priced.priceType) ?? null;
      return [
        {
          priceType: priced.priceType,
          priceName: row.name,
          listAmount: priced.listAmount,
          currency: row.currency,
          overrideAmount,
          effectiveAmount: overrideAmount ?? priced.listAmount,
        },
      ];
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
