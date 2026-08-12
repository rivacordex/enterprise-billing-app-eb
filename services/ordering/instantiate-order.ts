import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { productInventoryRepository } from "@/db/repositories/inventory/product-inventory.repository";
import { inventoryStatusHistoryRepository } from "@/db/repositories/inventory/inventory-status-history.repository";
import { productOrderRepository } from "@/db/repositories/ordering/product-order.repository";
import type { Database } from "@/db/client";
import type { ProductOrder, ProductOrderItem } from "@/types/ordering";

// pm30-spec §2 — the single definition of "create the subscription and complete
// the order", shared verbatim by pm28's standard `createOrder` path and pm30's
// `approveOrder` path: one place instantiates inventory, so the two callers can
// never drift. Runs entirely on the caller's already-open transaction `tx`
// (Inv. #19): inventory row + first status-history row + the order's flip to
// `COMPLETED` + the `PRODUCT_INVENTORY_CREATED` and `PRODUCT_ORDER_COMPLETED`
// audit events, all inside the caller's atomic unit — a failure here rolls the
// caller's whole transaction back.
//
// Every value comes from the persisted, write-once `order`/`item` rows (Inv.
// #15) rather than a re-parsed input, so approval instantiates against exactly
// what was submitted. `review` is supplied only by the approval path — it
// stamps `reviewed_by`/`reviewed_at` onto the same `COMPLETED` update (spec
// §2.4); the standard auto-completion path leaves both null.
export async function instantiateOrder(
  tx: Database,
  order: ProductOrder,
  item: ProductOrderItem,
  actorId: string,
  now: Date,
  review?: { reviewedBy: string; reviewedAt: Date },
): Promise<string> {
  const instanceCharacteristics = item.orderedCharacteristics ?? null;

  const inventory = await productInventoryRepository.insertInventory(tx, {
    productOrderItemId: item.productOrderItemId,
    customerPartyRoleId: order.customerPartyRoleId,
    billingAccountId: order.billingAccountId,
    productOfferingId: item.productOfferingId,
    quantity: item.quantity,
    instanceCharacteristics,
    status: "ACTIVE",
    startDate: item.startDate,
  });

  await inventoryStatusHistoryRepository.insertTransition(tx, {
    productInventoryId: inventory.productInventoryId,
    fromStatus: null,
    toStatus: "ACTIVE",
    effectiveDate: item.startDate,
    reason: `order ${order.productOrderId} completed`,
    changedBy: actorId,
  });

  await productOrderRepository.updateStatus(tx, order.productOrderId, {
    status: "COMPLETED",
    completedAt: now,
    ...(review
      ? { reviewedBy: review.reviewedBy, reviewedAt: review.reviewedAt }
      : {}),
  });

  await insertAuditEvent(tx, {
    eventType: "PRODUCT_INVENTORY_CREATED",
    actorUserId: actorId,
    targetEntity: "PRODUCT_INVENTORY",
    targetId: inventory.productInventoryId,
    beforeData: null,
    afterData: {
      productOrderItemId: item.productOrderItemId,
      customerPartyRoleId: order.customerPartyRoleId,
      billingAccountId: order.billingAccountId,
      productOfferingId: item.productOfferingId,
      quantity: item.quantity,
      startDate: item.startDate,
      status: "ACTIVE",
    },
  });

  await insertAuditEvent(tx, {
    eventType: "PRODUCT_ORDER_COMPLETED",
    actorUserId: actorId,
    targetEntity: "PRODUCT_ORDER",
    targetId: order.productOrderId,
    beforeData: { status: order.status },
    afterData: { status: "COMPLETED", completedAt: now },
  });

  return inventory.productInventoryId;
}
