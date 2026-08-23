"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { rerunRun } from "@/services/billing/rerun-run";
import type { RerunRunResult } from "@/services/billing/rerun-run";
import { rerunRunSchema } from "@/validation/billing/rerun-run.schema";

export type RerunRunActionResult =
  | RerunRunResult
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "VALIDATION_ERROR" };

// bm08-spec §Implementation §2 — the rerun action. Requires
// billrun_operate:EDIT (code-standards §8); Zod-parses
// `{ billRunId, accountIds[], fromStage, reason }` (empty reason ⇒
// VALIDATION_ERROR); delegates to `rerunRun`; revalidates the run pages on
// success only.
export async function rerunRunAction(
  rawInput: unknown,
): Promise<RerunRunActionResult> {
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

  const parsed = rerunRunSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, code: "VALIDATION_ERROR" };
  }

  const result = await rerunRun(
    {
      billRunId: parsed.data.billRunId,
      accountIds: parsed.data.accountIds,
      fromStage: parsed.data.fromStage,
      reason: parsed.data.reason,
    },
    actorId,
  );

  if (result.ok) {
    revalidatePath(`/billing/bill-runs/${parsed.data.billRunId}`);
    revalidatePath("/billing/bill-runs");
  }

  return result;
}
