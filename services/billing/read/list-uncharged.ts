import { db } from "@/db/client";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import type { UnchargedRow } from "@/types/billing";

// bm07-spec §Design/§Implementation §2, REDEFINED by bm32 §Implementation §1
// (Inv #22). The Uncharged tab's read — no longer the run's `EXCLUDED` accounts.
// "Uncharged" now means a **billing outcome**: a scoped, non-`EXCLUDED` account
// that produced **no `customer_bill_line`** (or whose lines net to zero). A
// recurring-only account with zero usage has RECURRING lines → it is BILLED and
// absent here; an account that ran and produced no line → uncharged. EXCLUDED
// accounts (a scoping-time partial-period exclusion) appear on NEITHER Uncharged
// nor the exception surface (Inv #26) — visible only via their status badge.
// Derived live, no cache read (architecture Inv. #12 idiom).
//
// The `reason` is a billing-outcome label derived from the line count:
// `NO_CHARGE_LINES` (no line at all) or `NETS_TO_ZERO` (lines summing to zero).
// The indicative value has no source — always `null`, rendered "—".
export async function listUncharged(
  billRunId: string,
): Promise<UnchargedRow[]> {
  const rows = await billRunAccountRepository.listUnchargedForRun(
    db,
    billRunId,
  );

  return rows.map((row) => ({
    billingAccountId: row.billingAccountId,
    financialAccountId: row.financialAccountId,
    accountName: row.accountName,
    reason: row.lineCount > 0 ? "NETS_TO_ZERO" : "NO_CHARGE_LINES",
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    // Indicative value has no source (no rating total exposed here) — "—".
    indicativeValue: null,
  }));
}
