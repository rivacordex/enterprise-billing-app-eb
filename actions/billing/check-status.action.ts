"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { reconcileRun } from "@/services/billing/reconcile-run";
import type { ReconcileRunResult } from "@/services/billing/reconcile-run";
import { checkStatusSchema } from "@/validation/billing/check-status.schema";

export type CheckStatusActionResult =
  | ReconcileRunResult
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "VALIDATION_ERROR" };

// bm12-spec §Implementation §4 — the "Check status" action. Requires
// billrun_operate:EDIT (code-standards §8); Zod-parses `{ billRunId }`;
// delegates to `reconcileRun`; revalidates the run page on success only.
export async function checkStatusAction(
  rawInput: unknown,
): Promise<CheckStatusActionResult> {
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

  const parsed = checkStatusSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, code: "VALIDATION_ERROR" };
  }

  const result = await reconcileRun(parsed.data.billRunId, actorId);

  if (result.ok) {
    revalidatePath(`/billing/bill-runs/${parsed.data.billRunId}`);
  }

  return result;
}
