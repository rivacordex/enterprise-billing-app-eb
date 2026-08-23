"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { postRun } from "@/services/billing/post-run";
import type { PostRunResult } from "@/services/billing/post-run";
import { postRunSchema } from "@/validation/billing/post-run.schema";

export type PostRunActionResult =
  | PostRunResult
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "VALIDATION_ERROR" };

// bm11-spec §Implementation §2 — the post action. Requires
// billrun_approve:EDIT (the same money gate as approve, code-standards §8);
// Zod-parses `{ billRunId }`; delegates to `postRun`; revalidates the run,
// approve, and list pages on success only. Re-invocable (resume).
export async function postRunAction(
  rawInput: unknown,
): Promise<PostRunActionResult> {
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

  const parsed = postRunSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, code: "VALIDATION_ERROR" };
  }

  const result = await postRun(parsed.data.billRunId, actorId);

  if (result.ok) {
    revalidatePath(`/billing/bill-runs/${parsed.data.billRunId}`);
    revalidatePath(`/billing/bill-runs/${parsed.data.billRunId}/approve`);
    revalidatePath("/billing/bill-runs");
  }

  return result;
}
