import { db } from "@/db/client";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import type { UnchargedRow } from "@/types/billing";

// bm07-spec §Design/§Implementation §2. The Uncharged tab's read — the run's
// `EXCLUDED` accounts (a scoping-time partial-period exclusion, bm03), each
// with its reason (`error_code`), the uncharged window (the run period), and
// the indicative value (`null` in v1 — no rating source). Derived live, no
// cache read. `EXCLUDED` accounts never reach any downstream stage, so this is
// the only surface that lists them.
export async function listUncharged(
  billRunId: string,
): Promise<UnchargedRow[]> {
  const rows = await billRunAccountRepository.listExcludedForRun(db, billRunId);

  return rows.map((row) => ({
    billingAccountId: row.billingAccountId,
    financialAccountId: row.financialAccountId,
    accountName: row.accountName,
    // Every EXCLUDED row is stamped `PARTIAL_PERIOD` at scoping; fall back to a
    // stable label if a future exclusion reason lands without a code.
    reason: row.reason ?? "PARTIAL_PERIOD",
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    // Indicative value has no source in v1 (no rating) — rendered as "—".
    indicativeValue: null,
  }));
}
