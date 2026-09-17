import { accountingPeriodRepository } from "@/db/repositories/accounts/accounting-period.repository";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import { auditLogRepository } from "@/db/repositories/audit-log.repository";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { billRunAccountStageRepository } from "@/db/repositories/billing/bill-run-account-stage.repository";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import { ratedLinesRepository } from "@/db/repositories/billing/rated-lines.repository";
import { periodPartitions } from "@/services/billing/derive-periods";
import type { Database } from "@/db/client";
import type { BillRun } from "@/db/schema/billing/bill-run";
import { TRIGGER_EVENT_TYPES } from "@/types/billing";
import type { PreApprovalCheck } from "@/types/billing";

// bm10-spec §Design/§Implementation §1. The five pre-approval checks, each a
// pure-ish read returning `{ check, pass, remediation }` — no state change.
// Runs against either `db` (the Approve page's live preview) or a `tx` (the
// approve transaction's re-check immediately before the write), so the
// confirm-panel figures and the enforced result can never drift. The
// `PreApprovalCheck`/`PreApprovalCheckKey` contracts live in `@/types/billing`
// so the client checklist component can import them without crossing the
// `components → services` boundary.

const TERMINAL_ACCOUNT_STATUSES: ReadonlySet<string> = new Set([
  "PROCESSED",
  "PROCESSING_FAILED",
  "EXCLUDED",
]);

// `gl_event_at` is already a `YYYY-MM-DD` calendar-date string (code-standards
// §2.5), so the accounting period key is a plain slice — no `Date` parsing.
function periodKeyFor(glEventAt: string): string {
  return glEventAt.slice(0, 7);
}

// Check 1 — the accounting period (keyed on `gl_event_at`) is not closed for
// any currency the run is about to post into. An absent period row is open
// (mirrors `post-document.ts`'s guard).
async function checkPeriodOpen(
  dbOrTx: Database,
  run: BillRun,
): Promise<PreApprovalCheck> {
  if (!run.glEventAt) {
    return {
      check: "period_open",
      pass: false,
      remediation: "This run has no GL event date yet.",
    };
  }
  const currencies = await customerBillRepository.listPostableCurrencies(
    dbOrTx,
    run.billRunId,
  );
  const period = periodKeyFor(run.glEventAt);
  for (const currency of currencies) {
    const row = await accountingPeriodRepository.findByPeriodAndCurrency(
      dbOrTx,
      period,
      currency,
    );
    if (row?.state === "closed") {
      return {
        check: "period_open",
        pass: false,
        remediation: `Period ${period} is closed for ${currency}. Reopen it in Accounts before approving.`,
      };
    }
  }
  return { check: "period_open", pass: true, remediation: null };
}

// Check 2 — the INV revenue + tax mappings resolve to a GL code
// (`gl_resolution_view`, bm09) for every currency the run is about to post
// into.
async function checkGlMappingsResolvable(
  dbOrTx: Database,
  run: BillRun,
): Promise<PreApprovalCheck> {
  const [currencies, taxCurrencyList] = await Promise.all([
    customerBillRepository.listPostableCurrencies(dbOrTx, run.billRunId),
    customerBillRepository.listPostableTaxCurrencies(dbOrTx, run.billRunId),
  ]);
  // `sys.tax_payable.{ccy}` is only needed where a taxed bill exists — posting
  // builds a tax leg only when `tax_total > 0`, so a zero-rated currency must
  // not be blocked on a tax mapping it will never use.
  const taxCurrencies = new Set(taxCurrencyList);
  const unresolved: string[] = [];
  for (const currency of currencies) {
    const names = [`sys.revenue.${currency}`];
    if (taxCurrencies.has(currency)) {
      names.push(`sys.tax_payable.${currency}`);
    }
    for (const name of names) {
      const glCode = await ledgerRepository.resolveGlCodeByName(dbOrTx, name);
      if (!glCode) unresolved.push(name);
    }
  }
  if (unresolved.length > 0) {
    return {
      check: "gl_mappings",
      pass: false,
      remediation: `GL mapping unresolved for: ${unresolved.join(", ")}. Map these in Accounts → Chart of Accounts.`,
    };
  }
  return { check: "gl_mappings", pass: true, remediation: null };
}

// Check 3 — a postable bill with a NEGATIVE `subtotal` or `total_amount` blocks
// approval. A bill is never a negative amount; that is a credit, and there is no
// credit-note path (known-issues §14).
//
// SIGN-BASED RULE (2026-09-17, owner decision). Zero does NOT block. The check's
// original premise — "zero-charge accounts were already excluded at Scoping"
// (bm10-spec §3) — stopped being true at bm32, which redefined Uncharged
// (Inv #22): a zero-charge account is now scoped, runs every stage, reaches
// `PROCESSED`, and is surfaced on the Uncharged tab, while the processor still
// writes an unconditional `subtotal-0.00` header for it (known-issues §11). So
// the old `<= 0` backstop fired on a shape it was never written for and made any
// run containing a no-charges account permanently unapprovable.
//
// Zero is instead handled by being *not posted* (`post-run.ts` skips it, so no
// INV and no ledger entry) and *reported* by the informational
// `zero_total_bills` check below. Keying this check on the sign rather than on
// line-presence also means a bill that nets to zero WITH lines — the
// fully-discounted case once discounting ships — is treated as an ordinary zero
// instead of wedging the run (known-issues §12).
async function checkNegativeTotals(
  dbOrTx: Database,
  run: BillRun,
): Promise<PreApprovalCheck> {
  const negative = await customerBillRepository.countNegativePostable(
    dbOrTx,
    run.billRunId,
  );
  if (negative > 0) {
    return {
      check: "positive_totals",
      pass: false,
      remediation: `${negative} bill${negative === 1 ? "" : "s"} ${negative === 1 ? "has" : "have"} a negative total. A bill is never a negative amount — review Customers & Bills.`,
    };
  }
  return { check: "positive_totals", pass: true, remediation: null };
}

// Check 3b (2026-09-17, owner decision) — the zero-total-bill count.
// INFORMATIONAL, never blocking: same contract as `orphan_count` below
// (`pass: true`, `informational: true`, excluded from `approveRun`'s gate).
//
// The visible half of the sign-based rule. Zero bills do not block and are not
// posted, so without this line they would be entirely invisible at the money
// gate — an approver should see that a run carries N bills worth nothing before
// signing. Counts every postable zero-total bill, line-less or not.
async function checkZeroTotalBills(
  dbOrTx: Database,
  run: BillRun,
): Promise<PreApprovalCheck> {
  const zeroTotal = await customerBillRepository.countZeroTotalPostable(
    dbOrTx,
    run.billRunId,
  );
  return {
    check: "zero_total_bills",
    pass: true,
    informational: true,
    remediation:
      zeroTotal > 0
        ? // Subject and verb have to agree in both directions: "1 bill totals
          // zero" / "3 bills total zero".
          `${zeroTotal} ${zeroTotal === 1 ? "bill totals" : "bills total"} zero — informational, does not block approval. Accounts that produced no charge line appear on the Uncharged tab.`
        : null,
  };
}

// Check 4 — four-eyes (segregation of duties): the approver must differ from
// EVERY operator who triggered or reran the run, not just the original trigger
// actor. The set is resolved from the `BILL_RUN_TRIGGERED`/`BILL_RUN_RERUN`
// audit trail (union'd with `bill_run.triggered_by` as a belt-and-suspenders
// base), so an Ops user who reran the run cannot then approve their own work —
// approval must come from a separate authorized approver (e.g. a manager). The
// `bill_run_approver_distinct_check` DB CHECK (`approved_by != triggered_by`)
// remains a backstop covering the original-trigger subset; this service check
// is the strictly-stronger primary enforcement (code-standards §1.6). The
// `TRIGGER_EVENT_TYPES` set is shared with the Approve preview (`types/billing`)
// so display and enforcement can't drift.
async function checkFourEyes(
  dbOrTx: Database,
  run: BillRun,
  approverId: string,
): Promise<PreApprovalCheck> {
  const actorIds = await auditLogRepository.listActorIdsForEvents(
    dbOrTx,
    run.billRunId,
    TRIGGER_EVENT_TYPES,
  );
  const blocked = new Set<string>(actorIds);
  if (run.triggeredBy) blocked.add(run.triggeredBy);
  const pass = blocked.size > 0 && !blocked.has(approverId);
  return {
    check: "four_eyes",
    pass,
    remediation: pass
      ? null
      : "You triggered or reran this run and cannot also approve it. Approval must come from a separate authorized approver.",
  };
}

// Check 5 — every scoped account has reached a terminal status. A backstop:
// `bill_run` only reaches `PROCESSED` once every account is terminal
// (`computeRunStatus`), and no M2M signal is accepted once the run leaves
// `PROCESSING` — so this should always pass for a `PROCESSED` run; it is
// re-verified live rather than assumed.
async function checkAccountsTerminal(
  dbOrTx: Database,
  run: BillRun,
): Promise<PreApprovalCheck> {
  const statuses = await billRunAccountRepository.listStatusesForRun(
    dbOrTx,
    run.billRunId,
  );
  const nonTerminal = statuses.filter(
    (s) => !TERMINAL_ACCOUNT_STATUSES.has(s.status),
  );
  if (nonTerminal.length > 0) {
    return {
      check: "accounts_terminal",
      pass: false,
      remediation: `${nonTerminal.length} account${nonTerminal.length === 1 ? "" : "s"} still processing.`,
    };
  }
  return { check: "accounts_terminal", pass: true, remediation: null };
}

// bm17-spec §Design "no_rejected_pending" pre-approval check. A backstop
// closing the reject → approve gap: fails while any account carries the
// `REJECTED_PENDING_REPROCESS` marker on its current-attempt latest stage row
// (`REJECTED_PENDING_REPROCESS` shared from `@/types/billing` so the reject
// write and this check can never drift on the literal string). The rerun's
// attempt bump clears the marker implicitly (Phase-2 review fold T6) — no
// explicit "clear" write exists anywhere.
async function checkNoRejectedPending(
  dbOrTx: Database,
  run: BillRun,
): Promise<PreApprovalCheck> {
  const rejected =
    await billRunAccountStageRepository.listRejectedPendingForRun(
      dbOrTx,
      run.billRunId,
    );
  if (rejected.length > 0) {
    return {
      check: "no_rejected_pending",
      pass: false,
      remediation: "Rerun the rejected accounts, then approve.",
    };
  }
  return { check: "no_rejected_pending", pass: true, remediation: null };
}

// bm32-spec §Design/§Implementation §3 — the orphaned-usage-record count.
// INFORMATIONAL, never blocking (D32/Inv #25): it always `pass`es (so it never
// contributes to `approveRun`'s `CHECKS_FAILED` gate) and carries an Info-line
// remediation naming the count, or a `null` remediation when there are none.
// Counts the run window's unclaimed live `RATED` `RAN_USAGE` rows — the same
// ORPHAN set the exception surface lists (`list-exceptions.ts`), scoped by the
// same window (the ≤2 UTC-month partitions the run spans + the `start_datetime`
// window), so the count equals what the operator sees there even for a
// `cycle_day != 1` run. The count is surfaced so an operator sees it, but a run
// bills fine with orphans present: the next run claims them once the inventory is
// fixed (Inv #25).
async function checkOrphanCount(
  dbOrTx: Database,
  run: BillRun,
): Promise<PreApprovalCheck> {
  const count = await ratedLinesRepository.countOrphansForWindow(dbOrTx, {
    partitions: periodPartitions(run.periodStart, run.periodEnd),
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
  });
  return {
    check: "orphan_count",
    pass: true,
    informational: true,
    remediation:
      count > 0
        ? `${count} orphaned usage record${count === 1 ? "" : "s"} — informational, does not block approval`
        : null,
  };
}

export async function runPreApprovalChecks(
  dbOrTx: Database,
  run: BillRun,
  approverId: string,
): Promise<PreApprovalCheck[]> {
  const [
    periodOpen,
    glMappings,
    positiveTotals,
    fourEyes,
    accountsTerminal,
    noRejectedPending,
    orphanCount,
    zeroTotalBills,
  ] = await Promise.all([
    checkPeriodOpen(dbOrTx, run),
    checkGlMappingsResolvable(dbOrTx, run),
    checkNegativeTotals(dbOrTx, run),
    checkFourEyes(dbOrTx, run, approverId),
    checkAccountsTerminal(dbOrTx, run),
    checkNoRejectedPending(dbOrTx, run),
    checkOrphanCount(dbOrTx, run),
    checkZeroTotalBills(dbOrTx, run),
  ]);

  return [
    periodOpen,
    glMappings,
    positiveTotals,
    fourEyes,
    accountsTerminal,
    noRejectedPending,
    orphanCount,
    zeroTotalBills,
  ];
}
