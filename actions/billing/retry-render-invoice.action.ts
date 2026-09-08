"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { retryRenderInvoice } from "@/services/billing/post-run";
import type { RetryRenderResult } from "@/services/billing/post-run";
import { retryRenderInvoiceSchema } from "@/validation/billing/retry-render-invoice.schema";

export type RetryRenderInvoiceActionResult =
  | RetryRenderResult
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "VALIDATION_ERROR" };

// bm19-spec §Implementation §4/§5 — the retry-render action, reached from
// the posting-progress view's per-row "Retry render" affordance. Same money
// gate as Post/Retry-failed (billrun_approve:EDIT, code-standards §8) — a
// render-pending account is still a posting-flow concern, not a plain
// viewer/operator action. Zod-parses `{ billRunId, billingAccountId }`;
// delegates to `retryRenderInvoice` (standalone — works regardless of the
// run's own status); revalidates the run + approve pages on success only.
export async function retryRenderInvoiceAction(
  rawInput: unknown,
): Promise<RetryRenderInvoiceActionResult> {
  try {
    await requirePermission(PERMISSIONS.BILLRUN_APPROVE, LEVELS.EDIT);
  } catch (e) {
    if (!isRedirectError(e)) throw e;
    return { ok: false, code: "FORBIDDEN" };
  }

  const parsed = retryRenderInvoiceSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, code: "VALIDATION_ERROR" };
  }

  const result = await retryRenderInvoice(
    parsed.data.billRunId,
    parsed.data.billingAccountId,
  );

  if (result.ok) {
    revalidatePath(`/billing/bill-runs/${parsed.data.billRunId}`);
    revalidatePath(`/billing/bill-runs/${parsed.data.billRunId}/approve`);
  }

  return result;
}
