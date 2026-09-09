"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { forceCompleteDistribution } from "@/services/billing/distribute-run";
import type { ForceCompleteDistributionResult } from "@/services/billing/distribute-run";
import { forceCompleteDistributionSchema } from "@/validation/billing/force-complete-distribution.schema";

export type ForceCompleteDistributionActionResult =
  | ForceCompleteDistributionResult
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "VALIDATION_ERROR" };

// bm20-spec §Phase-2 review fold T11 — force-complete/abandon:
// `DISTRIBUTION_FAILED` → `COMPLETED`, decoupling the GL period close from
// transport success when a mandatory target fails permanently (Inv #13).
// Gated on `billrun_approve:EDIT` (the money-gate permission, mirroring
// Approve/Post/Reject) — a mandatory reason is required, and D-T1 requires
// this control to route through a spelled-out danger-role confirm, never a
// bare/peer button next to "Rerun distribution".
export async function forceCompleteDistributionAction(
  rawInput: unknown,
): Promise<ForceCompleteDistributionActionResult> {
  let actorId: string;
  try {
    const { userId } = await requirePermission(
      PERMISSIONS.BILLRUN_APPROVE,
      LEVELS.EDIT,
    );
    actorId = userId;
  } catch (e) {
    if (!isRedirectError(e)) throw e;
    return { ok: false, code: "FORBIDDEN" };
  }

  const parsed = forceCompleteDistributionSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, code: "VALIDATION_ERROR" };
  }

  const result = await forceCompleteDistribution(
    parsed.data.billRunId,
    actorId,
    parsed.data.reason,
  );

  if (result.ok) {
    revalidatePath(`/billing/bill-runs/${parsed.data.billRunId}`);
  }

  return result;
}
