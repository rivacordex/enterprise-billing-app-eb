import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { productOrderRepository } from "@/db/repositories/ordering/product-order.repository";
import { productOrderItemRepository } from "@/db/repositories/ordering/product-order-item.repository";
import { orderItemPriceOverrideRepository } from "@/db/repositories/ordering/order-item-price-override.repository";
import {
  checkOrderPreconditions,
  type OrderPreconditionErrorCode,
} from "@/services/ordering/order-preconditions";
import { instantiateOrder } from "@/services/ordering/instantiate-order";
import type { CreateOrderInput } from "@/validation/ordering/create-order.schema";
import type { OrderStatus } from "@/types/ordering";

export type CreateOrderResult =
  | {
      ok: true;
      orderId: string;
      inventoryId: string | null;
      status: OrderStatus;
    }
  | { ok: false; code: OrderPreconditionErrorCode };

// pm28-spec §2. One transaction, TOCTOU-checked (Inv. #19): every precondition
// is re-read locked, immediately before any write, and the whole write set —
// precondition re-checks through the final audit event — commits or rolls
// back as a single unit (ac04/V7 atomicity precedent, code-standards
// pattern): an unexpected repo error anywhere after the order insert rolls
// back the order along with it, exactly like a precondition failure — there
// is no partially-committed order (pm28-spec §4 crash-injection proof).
// `now` is injectable (pm15 pattern) so tests control both the backdating
// boundary and the timestamps this service stamps.
export async function createOrder(
  input: CreateOrderInput,
  actorId: string,
  now: () => Date = () => new Date(),
): Promise<CreateOrderResult> {
  return db.transaction(async (tx) => {
    const nowValue = now();

    const precondition = await checkOrderPreconditions(tx, input, nowValue);
    if (!precondition.ok) {
      return precondition;
    }

    const hasOverride = (input.overrides?.length ?? 0) > 0;
    const orderedCharacteristics = input.characteristics ?? null;

    const order = await productOrderRepository.insertOrder(tx, {
      customerPartyRoleId: input.customerPartyRoleId,
      billingAccountId: input.billingAccountId,
      status: hasOverride ? "PENDING" : "ACKNOWLEDGED",
      submittedBy: actorId,
    });

    const item = await productOrderItemRepository.insertItem(tx, {
      productOrderId: order.productOrderId,
      productOfferingId: input.productOfferingId,
      quantity: input.quantity,
      startDate: input.startDate,
      orderedCharacteristics,
    });

    if (hasOverride) {
      for (const override of input.overrides ?? []) {
        await orderItemPriceOverrideRepository.insertOverride(tx, {
          productOrderItemId: item.productOrderItemId,
          priceType: override.priceType,
          amount: override.amount,
          currency: override.currency,
        });
      }
    }

    await insertAuditEvent(tx, {
      eventType: "PRODUCT_ORDER_CREATED",
      actorUserId: actorId,
      targetEntity: "PRODUCT_ORDER",
      targetId: order.productOrderId,
      beforeData: null,
      afterData: {
        customerPartyRoleId: input.customerPartyRoleId,
        billingAccountId: input.billingAccountId,
        productOfferingId: input.productOfferingId,
        quantity: input.quantity,
        startDate: input.startDate,
        status: order.status,
        hasOverride,
      },
    });

    if (hasOverride) {
      await insertAuditEvent(tx, {
        eventType: "PRODUCT_ORDER_PENDING_APPROVAL",
        actorUserId: actorId,
        targetEntity: "PRODUCT_ORDER",
        targetId: order.productOrderId,
        beforeData: null,
        afterData: {
          status: "PENDING",
          overrideCount: input.overrides?.length ?? 0,
        },
      });

      return {
        ok: true,
        orderId: order.productOrderId,
        inventoryId: null,
        status: "PENDING",
      };
    }

    // Standard (no-override) path: instantiate the subscription and complete
    // the order — same transaction, same atomicity guarantee as everything
    // above. Shared verbatim with pm30's approval path via `instantiateOrder`
    // (one definition of "create the subscription"); no `review` here — an
    // auto-completed order was never reviewed.
    const inventoryId = await instantiateOrder(
      tx,
      order,
      item,
      actorId,
      nowValue,
    );

    return {
      ok: true,
      orderId: order.productOrderId,
      inventoryId,
      status: "COMPLETED",
    };
  });
}
