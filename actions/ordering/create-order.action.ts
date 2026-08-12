"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { createOrder } from "@/services/ordering/create-order";
import { createOrderSchema } from "@/validation/ordering/create-order.schema";
import type { OrderPreconditionErrorCode } from "@/services/ordering/order-preconditions";
import type { OrderStatus } from "@/types/ordering";

export type CreateOrderActionResult =
  | {
      ok: true;
      orderId: string;
      inventoryId: string | null;
      status: OrderStatus;
    }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: OrderPreconditionErrorCode }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// pm29-spec §Implementation-1. Standard Server Action shape (pm19 precedent,
// architecture §1 table): guard -> isRedirectError catch -> safeParse ->
// delegate to pm28's createOrder -> revalidatePath -> typed {ok,code} result.
// Every pm28 precondition error code passes through untouched (same
// direct-passthrough shape as update-offering.action.ts/insert-price.action.ts).
export async function createOrderAction(
  rawInput: unknown,
): Promise<CreateOrderActionResult> {
  let actorId: string;
  try {
    ({ userId: actorId } = await requirePermission(
      PERMISSIONS.PRODUCT_ORDERS,
      LEVELS.EDIT,
    ));
  } catch (error) {
    if (isRedirectError(error)) {
      return { ok: false, code: "FORBIDDEN" };
    }
    return { ok: false, code: "SERVER_ERROR" };
  }

  const parsed = createOrderSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result;
  try {
    result = await createOrder(parsed.data, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return { ok: false, code: result.code };
  }

  // Both surfaces a completed order can affect (pm29-spec §Implementation-1):
  // the Orders list itself, and Subscriptions, since a standard order
  // instantiates inventory in the same transaction.
  revalidatePath("/products/orders");
  revalidatePath("/products/subscriptions");

  return {
    ok: true,
    orderId: result.orderId,
    inventoryId: result.inventoryId,
    status: result.status,
  };
}
