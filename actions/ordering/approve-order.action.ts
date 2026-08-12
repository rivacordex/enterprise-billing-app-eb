"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { approveOrder } from "@/services/ordering/review-order";
import { approveOrderSchema } from "@/validation/ordering/review-order.schema";
import type { ReviewOrderErrorCode } from "@/services/ordering/review-order";
import type { OrderStatus } from "@/types/ordering";

export type ApproveOrderActionResult =
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
// (approve variant) -> pm30's `approveOrder` -> revalidatePath -> typed result.
// Every pm30 `ReviewOrderErrorCode` (the review-specific NOT_MANAGER/
// ORDER_NOT_FOUND/ORDER_NOT_PENDING/SELF_REVIEW plus the full precondition set
// re-run under locks at approval time) passes through unchanged; the client
// maps each to a user-readable message (ReviewActions), including the stale-
// precondition "Cannot approve: <reason>…" copy. Approval re-validates
// regardless of what the UI showed (platform Inv. #3); this layer is UX-only.
export async function approveOrderAction(
  rawInput: unknown,
): Promise<ApproveOrderActionResult> {
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

  const parsed = approveOrderSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result;
  try {
    // `approveOrder` takes no reason (approve has no reason semantics — the
    // schema's optional `reason` is validated for symmetry but not consumed;
    // only reject requires one).
    result = await approveOrder(parsed.data.orderId, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return { ok: false, code: result.code };
  }

  // Approval instantiates the subscription in the same transaction, so both
  // surfaces change (pm31-spec §1: "+ subscriptions on approve").
  revalidatePath("/products/orders");
  revalidatePath("/products/subscriptions");

  return {
    ok: true,
    orderId: result.orderId,
    inventoryId: result.inventoryId,
    status: result.status,
  };
}
