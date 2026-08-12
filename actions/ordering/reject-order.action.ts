"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { rejectOrder } from "@/services/ordering/review-order";
import { rejectOrderSchema } from "@/validation/ordering/review-order.schema";
import type { ReviewOrderErrorCode } from "@/services/ordering/review-order";
import type { OrderStatus } from "@/types/ordering";

export type RejectOrderActionResult =
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
  | { ok: false; code: ReviewOrderErrorCode }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// pm31-spec §Implementation-1. Standard Server Action shape (pm29/create-order
// precedent): guard `product_orders:EDIT` -> isRedirectError catch -> safeParse
// (reject variant — `reason` required, min 1) -> pm30's `rejectOrder` ->
// revalidatePath -> typed result. Reject is terminal and never instantiates
// inventory, so only the orders list changes (pm31-spec §1 revalidates
// `/products/orders` only, no subscriptions). The pm30 codes it can actually
// return are NOT_MANAGER/ORDER_NOT_FOUND/ORDER_NOT_PENDING/SELF_REVIEW (reject
// runs no precondition re-check); the wider `ReviewOrderErrorCode` union is
// carried for shape-parity with approve, and the client maps every code.
export async function rejectOrderAction(
  rawInput: unknown,
): Promise<RejectOrderActionResult> {
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

  const parsed = rejectOrderSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result;
  try {
    result = await rejectOrder(
      parsed.data.orderId,
      actorId,
      parsed.data.reason,
    );
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return { ok: false, code: result.code };
  }

  revalidatePath("/products/orders");

  return {
    ok: true,
    orderId: result.orderId,
    inventoryId: result.inventoryId,
    status: result.status,
  };
}
