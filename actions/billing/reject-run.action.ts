"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { rejectRun } from "@/services/billing/reject-run";
import type { RejectRunResult } from "@/services/billing/reject-run";
import { rejectRunSchema } from "@/validation/billing/reject-run.schema";

export type RejectRunActionResult =
  | RejectRunResult
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "VALIDATION_ERROR" };

// bm17-spec §Implementation §2/§6 — the reject action. Requires
// billrun_approve:EDIT (reject is an approver action — segregation of duties,
// code-standards §8; it does NOT bar the rejecter from later approving);
// Zod-parses `{ billRunId, scope, banIds[], reason }` (empty reason ⇒
// VALIDATION_ERROR); delegates to `rejectRun`; revalidates the run + approve
// pages on success only.
export async function rejectRunAction(
  rawInput: unknown,
): Promise<RejectRunActionResult> {
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

  const parsed = rejectRunSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, code: "VALIDATION_ERROR" };
  }

  const result = await rejectRun(
    {
      billRunId: parsed.data.billRunId,
      scope: parsed.data.scope,
      banIds: parsed.data.banIds,
      reason: parsed.data.reason,
    },
    actorId,
  );

  if (result.ok) {
    revalidatePath(`/billing/bill-runs/${parsed.data.billRunId}`);
    revalidatePath(`/billing/bill-runs/${parsed.data.billRunId}/approve`);
    revalidatePath("/billing/bill-runs");
  }

  return result;
}
