import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { orderItemPriceOverrideRepository } from "@/db/repositories/ordering/order-item-price-override.repository";
import { productOrderItemRepository } from "@/db/repositories/ordering/product-order-item.repository";
import { productOrderRepository } from "@/db/repositories/ordering/product-order.repository";
import { actorHasRole } from "@/auth/roles";
import {
  checkOrderPreconditions,
  type OrderPreconditionErrorCode,
} from "@/services/ordering/order-preconditions";
import { instantiateOrder } from "@/services/ordering/instantiate-order";
import type { Database } from "@/db/client";
import type { CreateOrderInput } from "@/validation/ordering/create-order.schema";
import type { OrderStatus, ProductOrder } from "@/types/ordering";
import type { PriceType } from "@/types/product";

const MANAGER_ROLE = "MANAGER";

// The review-specific rejection codes plus every precondition code (approval
// re-runs the full submission validation set — a failure surfaces its concrete
// code so the reviewer knows why and can reject).
export type ReviewOrderErrorCode =
  | "NOT_MANAGER"
  | "ORDER_NOT_FOUND"
  | "ORDER_NOT_PENDING"
  | "SELF_REVIEW"
  | OrderPreconditionErrorCode;

export type ReviewOrderResult =
  | {
      ok: true;
      orderId: string;
      inventoryId: string | null;
      status: OrderStatus;
    }
  | { ok: false; code: ReviewOrderErrorCode };

// Steps 1–2 shared by approve and reject (spec §2): the live per-request
// MANAGER-role gate, then the locked order re-read that serializes concurrent
// reviewers and enforces PENDING-only + reviewer ≠ submitter. Returns the
// locked, still-PENDING order on success; a typed error code otherwise. The
// caller stays inside the same transaction `tx` for its own writes.
async function lockPendingOrderForReview(
  tx: Database,
  orderId: string,
  actorId: string,
): Promise<
  { ok: true; order: ProductOrder } | { ok: false; code: ReviewOrderErrorCode }
> {
  const order = await productOrderRepository.findByIdForUpdate(tx, orderId);
  if (!order) {
    return { ok: false, code: "ORDER_NOT_FOUND" };
  }
  // Re-read under the row lock (pm16 `retireOffering` pattern): approve-vs-
  // approve and approve-vs-reject serialize here — the second reviewer sees a
  // non-PENDING status and aborts, so exactly one outcome ever lands.
  if (order.status !== "PENDING") {
    return { ok: false, code: "ORDER_NOT_PENDING" };
  }
  // Service-level self-review guard (architecture Inv. #22); the DB CHECK
  // `reviewed_by <> submitted_by` backstops it.
  if (order.submittedBy === actorId) {
    return { ok: false, code: "SELF_REVIEW" };
  }
  return { ok: true, order };
}

// pm30-spec §2 — approve a PENDING override order. Authority = permission (the
// action layer's `product_orders:EDIT`) + MANAGER role (here) + identity
// (reviewer ≠ submitter, below). On success the entire pm28 precondition set
// re-runs under locks, then the subscription is instantiated and the order
// completes, stamped `reviewed_by`/`reviewed_at`. `now` is injectable (pm15
// pattern) so tests pin the backdating boundary and the stamped timestamps.
export async function approveOrder(
  orderId: string,
  actorId: string,
  now: () => Date = () => new Date(),
): Promise<ReviewOrderResult> {
  if (!(await actorHasRole(actorId, MANAGER_ROLE))) {
    return { ok: false, code: "NOT_MANAGER" };
  }

  return db.transaction(async (tx) => {
    const nowValue = now();

    const gate = await lockPendingOrderForReview(tx, orderId, actorId);
    if (!gate.ok) {
      return gate;
    }
    const { order } = gate;

    const items = await productOrderItemRepository.findByOrderId(
      tx,
      order.productOrderId,
    );
    const item = items[0];
    // A well-formed order always has its (single) item; a headerless-item
    // order is treated as not-found rather than throwing (get-order-detail
    // precedent).
    if (!item) {
      return { ok: false, code: "ORDER_NOT_FOUND" };
    }

    const overrides = await orderItemPriceOverrideRepository.findByItemId(
      tx,
      item.productOrderItemId,
    );

    // Reconstruct the exact submission input from the persisted, write-once
    // rows (Inv. #15) so `checkOrderPreconditions` — the single validation
    // source shared with pm28's submit — re-runs verbatim under locks at
    // approval time (spec Design: "Approval is not a status flip"). The
    // override `priceType` came in through the validated wire schema, so it is
    // always a valid `PriceType`.
    const input: CreateOrderInput = {
      customerPartyRoleId: order.customerPartyRoleId,
      billingAccountId: order.billingAccountId,
      productOfferingId: item.productOfferingId,
      quantity: item.quantity,
      startDate: item.startDate,
      characteristics: item.orderedCharacteristics ?? undefined,
      overrides: overrides.map((o) => ({
        priceType: o.priceType as PriceType,
        amount: o.amount,
        currency: o.currency,
      })),
    };

    const precondition = await checkOrderPreconditions(tx, input, nowValue);
    if (!precondition.ok) {
      // Any failure aborts the approval (no write happens) and the order stays
      // PENDING — the reviewer sees the concrete code and can reject.
      return precondition;
    }

    await insertAuditEvent(tx, {
      eventType: "PRODUCT_ORDER_APPROVED",
      actorUserId: actorId,
      targetEntity: "PRODUCT_ORDER",
      targetId: order.productOrderId,
      beforeData: { status: order.status },
      afterData: { status: "COMPLETED", reviewedBy: actorId },
    });

    // Instantiate exactly as pm28's standard path (inventory + history +
    // PRODUCT_INVENTORY_CREATED + PRODUCT_ORDER_COMPLETED), stamping the
    // reviewer onto the same COMPLETED update (spec §2.4).
    const inventoryId = await instantiateOrder(
      tx,
      order,
      item,
      actorId,
      nowValue,
      { reviewedBy: actorId, reviewedAt: nowValue },
    );

    return {
      ok: true,
      orderId: order.productOrderId,
      inventoryId,
      status: "COMPLETED",
    };
  });
}

// pm30-spec §2 — reject a PENDING override order. Same steps 1–2 as approve
// (MANAGER gate, locked PENDING re-read, reviewer ≠ submitter); sets REJECTED +
// `failure_reason` + `reviewed_by`/`reviewed_at`. Terminal, no inventory, no
// re-validation (a reject never instantiates). `reason` is required, already
// enforced by `rejectOrderSchema` (pm25) at the action layer.
export async function rejectOrder(
  orderId: string,
  actorId: string,
  reason: string,
  now: () => Date = () => new Date(),
): Promise<ReviewOrderResult> {
  if (!(await actorHasRole(actorId, MANAGER_ROLE))) {
    return { ok: false, code: "NOT_MANAGER" };
  }

  return db.transaction(async (tx) => {
    const nowValue = now();

    const gate = await lockPendingOrderForReview(tx, orderId, actorId);
    if (!gate.ok) {
      return gate;
    }
    const { order } = gate;

    await productOrderRepository.updateStatus(tx, order.productOrderId, {
      status: "REJECTED",
      reviewedBy: actorId,
      reviewedAt: nowValue,
      failureReason: reason,
    });

    await insertAuditEvent(tx, {
      eventType: "PRODUCT_ORDER_REJECTED",
      actorUserId: actorId,
      targetEntity: "PRODUCT_ORDER",
      targetId: order.productOrderId,
      beforeData: { status: order.status },
      afterData: {
        status: "REJECTED",
        reviewedBy: actorId,
        failureReason: reason,
      },
    });

    return {
      ok: true,
      orderId: order.productOrderId,
      inventoryId: null,
      status: "REJECTED",
    };
  });
}
