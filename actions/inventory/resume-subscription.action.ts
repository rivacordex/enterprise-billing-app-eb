"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { resumeSubscription } from "@/services/inventory/resume-subscription";
import { resumeSubscriptionSchema } from "@/validation/inventory/resume.schema";
import type { LifecycleErrorCode } from "@/services/inventory/lifecycle-guards";

export type ResumeSubscriptionActionResult =
  | { ok: true; inventoryId: string; status: "ACTIVE" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: LifecycleErrorCode }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

// pm33-spec §Implementation-3. Same shape as suspend-subscription.action.ts.
// resumeSubscriptionSchema takes no reason (resume-day proration is reserved
// to the bill-run phase, Q17/Q20).
export async function resumeSubscriptionAction(
  rawInput: unknown,
): Promise<ResumeSubscriptionActionResult> {
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

  const parsed = resumeSubscriptionSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    };
  }

  let result;
  try {
    result = await resumeSubscription(parsed.data, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return { ok: false, code: result.code };
  }

  revalidatePath("/products/subscriptions");

  return { ok: true, inventoryId: result.inventoryId, status: result.status };
}
