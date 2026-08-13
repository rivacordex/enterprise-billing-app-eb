"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { terminateSubscription } from "@/services/inventory/terminate-subscription";
import { terminateSubscriptionSchema } from "@/validation/inventory/terminate.schema";
import type { TerminateSubscriptionErrorCode } from "@/services/inventory/terminate-subscription";

export type TerminateSubscriptionActionResult =
  | { ok: true; inventoryId: string; status: "TERMINATED" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: TerminateSubscriptionErrorCode }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// pm33-spec §Implementation-3. Same shape as suspend-subscription.action.ts.
// Terminate is terminal (ACTIVE|SUSPENDED -> TERMINATED); its own
// END_BEFORE_START code (end_date < start_date) passes through alongside the
// shared LifecycleErrorCode set.
export async function terminateSubscriptionAction(
  rawInput: unknown,
): Promise<TerminateSubscriptionActionResult> {
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

  const parsed = terminateSubscriptionSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    };
  }

  let result;
  try {
    result = await terminateSubscription(parsed.data, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return { ok: false, code: result.code };
  }

  revalidatePath("/products/subscriptions");

  return { ok: true, inventoryId: result.inventoryId, status: result.status };
}
