"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { approveRun } from "@/services/billing/approve-run";
import type { ApproveRunResult } from "@/services/billing/approve-run";
import { approveRunSchema } from "@/validation/billing/approve-run.schema";

export type ApproveRunActionResult =
  | ApproveRunResult
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "VALIDATION_ERROR" };

// bm10-spec §Implementation §2 — the approve action. Requires
// billrun_approve:EDIT (code-standards §8); Zod-parses `{ billRunId }`;
// delegates to `approveRun`; revalidates the run + list pages on success only.
export async function approveRunAction(
  rawInput: unknown,
): Promise<ApproveRunActionResult> {
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

  const parsed = approveRunSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, code: "VALIDATION_ERROR" };
  }

  const result = await approveRun(parsed.data.billRunId, actorId);

  if (result.ok) {
    revalidatePath(`/billing/bill-runs/${parsed.data.billRunId}`);
    revalidatePath(`/billing/bill-runs/${parsed.data.billRunId}/approve`);
    revalidatePath("/billing/bill-runs");
  }

  return result;
}
