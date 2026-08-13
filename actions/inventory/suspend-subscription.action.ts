"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { suspendSubscription } from "@/services/inventory/suspend-subscription";
import { suspendSubscriptionSchema } from "@/validation/inventory/suspend.schema";
import type { LifecycleErrorCode } from "@/services/inventory/lifecycle-guards";

export type SuspendSubscriptionActionResult =
  | { ok: true; inventoryId: string; status: "SUSPENDED" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: LifecycleErrorCode }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// pm33-spec §Implementation-3. Standard Server Action shape (pm29/create-order
// precedent): guard product_inventory:EDIT -> isRedirectError catch ->
// safeParse -> delegate to pm32's suspendSubscription -> revalidatePath ->
// typed {ok,code} result. Every pm32 LifecycleErrorCode passes through
// unchanged — the dialog maps each to a user-readable message, including
// INVALID_TRANSITION's "Subscription is no longer <status> — refresh and
// retry" copy (pm33-spec §3).
export async function suspendSubscriptionAction(
  rawInput: unknown,
): Promise<SuspendSubscriptionActionResult> {
  let actorId: string;
  try {
    ({ userId: actorId } = await requirePermission(
      PERMISSIONS.PRODUCT_INVENTORY,
      LEVELS.EDIT,
    ));
  } catch (error) {
    if (isRedirectError(error)) {
      return { ok: false, code: "FORBIDDEN" };
    }
    return { ok: false, code: "SERVER_ERROR" };
  }

  const parsed = suspendSubscriptionSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  let result;
  try {
    result = await suspendSubscription(parsed.data, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return { ok: false, code: result.code };
  }

  revalidatePath("/products/subscriptions");

  return { ok: true, inventoryId: result.inventoryId, status: result.status };
}
