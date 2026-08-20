"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { triggerRun } from "@/services/billing/trigger-run";
import type { TriggerRunResult } from "@/services/billing/trigger-run";
import { triggerRunSchema } from "@/validation/billing/trigger-run.schema";

export type TriggerRunActionResult =
  | TriggerRunResult
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "VALIDATION_ERROR" };

// bm03-spec §Implementation §7 — the trigger action. Requires
// billrun_operate:EDIT (code-standards §8).
export async function triggerRunAction(
  rawInput: unknown,
): Promise<TriggerRunActionResult> {
  let actorId: string;
  try {
    const { userId } = await requirePermission(
      PERMISSIONS.BILLRUN_OPERATE,
      LEVELS.EDIT,
    );
    actorId = userId;
  } catch (e) {
    if (!isRedirectError(e)) throw e;
    return { ok: false, code: "FORBIDDEN" };
  }

  const parsed = triggerRunSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, code: "VALIDATION_ERROR" };
  }

  const result = await triggerRun(parsed.data.billRunId, actorId);

  if (result.ok) {
    revalidatePath("/billing/bill-runs");
  }

  return result;
}
