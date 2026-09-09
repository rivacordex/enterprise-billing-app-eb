"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { rerunDistribution } from "@/services/billing/distribute-run";
import type { RerunDistributionResult } from "@/services/billing/distribute-run";
import { rerunDistributionSchema } from "@/validation/billing/rerun-distribution.schema";

export type RerunDistributionActionResult =
  | RerunDistributionResult
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "VALIDATION_ERROR" };

// bm20-spec §Implementation §3 — "Rerun distribution", the DISTRIBUTION_FAILED
// run's primary/emphasized affordance (D-T1's control hierarchy). Requires
// `billrun_operate:EDIT` — a redelivery attempt, not the money-gate action
// (that's the T11 force-complete below, gated on `billrun_approve`).
export async function rerunDistributionAction(
  rawInput: unknown,
): Promise<RerunDistributionActionResult> {
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

  const parsed = rerunDistributionSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, code: "VALIDATION_ERROR" };
  }

  const result = await rerunDistribution(parsed.data.billRunId, actorId);

  if (result.ok) {
    revalidatePath(`/billing/bill-runs/${parsed.data.billRunId}`);
  }

  return result;
}
