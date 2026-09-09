"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { triggerDistribution } from "@/services/billing/distribute-run";
import type { TriggerDistributionResult } from "@/services/billing/distribute-run";
import { startDistributionSchema } from "@/validation/billing/start-distribution.schema";

export type StartDistributionActionResult =
  | TriggerDistributionResult
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "VALIDATION_ERROR" };

// bm20-spec §Phase-2 review fold T2 — the "Start distribution" action for an
// `INVOICED` run whose automatic trigger (`post-run.ts`) was lost (an app
// crash between the `INVOICED` commit and the trigger call) or failed
// (engine unreachable). Requires `billrun_operate:EDIT` (code-standards §8);
// re-invokes the SAME idempotent `triggerDistribution` the automatic path
// calls, passing the real actor id (not `null` — this IS an operator
// mutation, `BILL_RUN_DISTRIBUTION_STARTED` records who started it).
export async function startDistributionAction(
  rawInput: unknown,
): Promise<StartDistributionActionResult> {
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

  const parsed = startDistributionSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, code: "VALIDATION_ERROR" };
  }

  const result = await triggerDistribution(parsed.data.billRunId, actorId);

  if (result.ok) {
    revalidatePath(`/billing/bill-runs/${parsed.data.billRunId}`);
  }

  return result;
}
