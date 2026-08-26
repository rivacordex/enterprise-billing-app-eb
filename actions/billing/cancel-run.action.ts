"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { cancelRun } from "@/services/billing/cancel-run";
import type { CancelRunResult } from "@/services/billing/cancel-run";
import { cancelRunSchema } from "@/validation/billing/cancel-run.schema";

export type CancelRunActionResult =
  | CancelRunResult
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "VALIDATION_ERROR" };

// bm12-spec §Implementation §4 — the "Cancel run" action. Requires
// billrun_operate:EDIT (code-standards §8); Zod-parses `{ billRunId }`;
// delegates to `cancelRun`; revalidates the run + list pages on success only
// (the run becomes re-triggerable, so the list page's "Run" affordance
// changes too).
export async function cancelRunAction(
  rawInput: unknown,
): Promise<CancelRunActionResult> {
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

  const parsed = cancelRunSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, code: "VALIDATION_ERROR" };
  }

  const result = await cancelRun(parsed.data.billRunId, actorId);

  if (result.ok) {
    revalidatePath(`/billing/bill-runs/${parsed.data.billRunId}`);
    revalidatePath("/billing/bill-runs");
  }

  return result;
}
