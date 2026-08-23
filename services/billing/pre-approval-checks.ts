import { accountingPeriodRepository } from "@/db/repositories/accounts/accounting-period.repository";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import { auditLogRepository } from "@/db/repositories/audit-log.repository";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import type { Database } from "@/db/client";
import type { BillRun } from "@/db/schema/billing/bill-run";
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

// Check 3 — a backstop: zero-charge accounts were already excluded at
// Scoping, but any postable bill with `total_amount <= 0` blocks approval.
async function checkPositiveTotals(
  dbOrTx: Database,
  run: BillRun,
): Promise<PreApprovalCheck> {
  const nonPositive = await customerBillRepository.countNonPositivePostable(
    dbOrTx,
    run.billRunId,
  );
  if (nonPositive > 0) {
    return {
      check: "positive_totals",
      pass: false,
      remediation: `${nonPositive} bill${nonPositive === 1 ? "" : "s"} have a zero or negative total. Review Customers & Bills.`,
    };
  }
  return { check: "positive_totals", pass: true, remediation: null };
}

// Check 4 — four-eyes (segregation of duties): the approver must differ from
// EVERY operator who triggered or reran the run, not just the original trigger
// actor. The set is resolved from the `BILL_RUN_TRIGGERED`/`BILL_RUN_RERUN`
// audit trail (union'd with `bill_run.triggered_by` as a belt-and-suspenders
// base), so an Ops user who reran the run cannot then approve their own work —
// approval must come from a separate authorized approver (e.g. a manager). The
// `bill_run_approver_distinct_check` DB CHECK (`approved_by != triggered_by`)
// remains a backstop covering the original-trigger subset; this service check
// is the strictly-stronger primary enforcement (code-standards §1.6).
const TRIGGER_EVENT_TYPES = ["BILL_RUN_TRIGGERED", "BILL_RUN_RERUN"] as const;

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

export async function runPreApprovalChecks(
  dbOrTx: Database,
  run: BillRun,
  approverId: string,
): Promise<PreApprovalCheck[]> {
  const [periodOpen, glMappings, positiveTotals, fourEyes, accountsTerminal] =
    await Promise.all([
      checkPeriodOpen(dbOrTx, run),
      checkGlMappingsResolvable(dbOrTx, run),
      checkPositiveTotals(dbOrTx, run),
      checkFourEyes(dbOrTx, run, approverId),
      checkAccountsTerminal(dbOrTx, run),
    ]);

  return [periodOpen, glMappings, positiveTotals, fourEyes, accountsTerminal];
}
