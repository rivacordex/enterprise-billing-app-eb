// bm07-spec §Visual, REDEFINED + EXTENDED by bm32 §Implementation §4. The
// Uncharged tab renders TWO Info-family sections (never the destructive Errors
// styling — code-standards §4.7):
//   1. Uncharged accounts — scoped, non-EXCLUDED accounts that produced no
//      `customer_bill_line` (or lines netting to zero), Inv #22. A billing
//      outcome, not a scoping decision: a recurring-only account with usage is
//      BILLED and absent here. Per row: account, reason, uncharged window,
//      indicative value ("—" — no rating source), and a deep link to Accounts →
//      Transactions for recovery via a manual DBN/ADJ.
//   2. Exceptions — the per-record surface (`BILL_NOTUSED` rows + orphans,
//      Inv #25/D32): one row per record, an unresolvable orphan shown by its
//      subscriber ref (NULL account). Info family (`--color-info-*`), distinct
//      from the Errors tab's danger accent.
// EXCLUDED accounts appear in NEITHER (Inv #26) — visible only via their status
// badge on the Workflow timeline. Server component (native tables + `<Link>`);
// zero rows in each section is a positive empty state, not a blank tab.

import { ArrowUpRight, CircleCheck } from "lucide-react";
import Link from "next/link";

import { ExportUnchargedButton } from "@/components/billing/export-uncharged-button";
import { formatCalendarDate, formatCurrency } from "@/lib/formatters";
import type { ExceptionRow, UnchargedRow } from "@/types/billing";

export interface UnchargedTableProps {
  runId: string;
  rows: UnchargedRow[];
  // bm32 — the per-record exception surface (BILL_NOTUSED rows + orphans).
  exceptions: ExceptionRow[];
  // Whether the viewer can reach Accounts → Transactions (gated by
  // `accounts_transactions:READ`). When false the recovery link would dead-end
  // at /no-access, so it renders as a plain, non-linking hint instead.
  canRecover: boolean;
  // bm32 — for the Exceptions section's rated-value money column, formatted
  // through the shared `formatCurrency` like every other money cell (§4).
  locale: string;
}

function transactionsHref(row: UnchargedRow): string {
  const params = new URLSearchParams({
    fa: row.financialAccountId,
    ban: row.billingAccountId,
  });
  return `/accounts/transactions?${params.toString()}`;
}

function InfoBadge({ label }: { label: string }): React.JSX.Element {
  return (
    <span className="inline-flex items-center rounded-full bg-[color:var(--color-info-50)] px-2 py-0.5 text-[11px] font-semibold tracking-wider text-[color:var(--color-info-700)] uppercase">
      {label}
    </span>
  );
}

function UnchargedAccountsSection({
  runId,
  rows,
  canRecover,
}: {
  runId: string;
  rows: UnchargedRow[];
  canRecover: boolean;
}): React.JSX.Element {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-body font-semibold text-foreground">
            Uncharged accounts
          </h2>
          <p className="text-body-sm text-muted-foreground">
            {rows.length === 0
              ? "No scoped accounts were left uncharged this run."
              : `${rows.length} account${rows.length === 1 ? "" : "s"} left uncharged this run (no charge lines, or lines netting to zero) — recover each via a manual DBN/ADJ against the account.`}
          </p>
        </div>
        <ExportUnchargedButton runId={runId} />
      </div>

      {rows.length === 0 ? (
        <div className="rounded-none bg-card p-10 text-center shadow-sm">
          <CircleCheck
            className="mx-auto mb-3 size-10 text-[color:var(--color-success-500)]"
            aria-hidden="true"
          />
          <p className="text-body font-semibold text-foreground">
            No uncharged accounts
          </p>
          <p className="mt-1 text-body-sm text-muted-foreground">
            Nothing was left uncharged this run.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-none border-l-2 border-[color:var(--color-info-500)] bg-card shadow-sm">
          <table className="w-full border-collapse text-body-sm">
            <thead>
              <tr className="border-b border-border bg-[color:var(--surface-sunken)]">
                <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                  Account
                </th>
                <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                  Reason
                </th>
                <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                  Uncharged window
                </th>
                <th className="px-4 py-3 text-right text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                  Indicative value
                </th>
                <th className="px-4 py-3 text-right text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                  Recover
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.billingAccountId}
                  className="border-b border-[color:var(--border-subtle)] hover:bg-[color:var(--color-neutral-50)]"
                >
                  <td className="px-4 py-3 align-top">
                    <div className="font-medium text-foreground">
                      {row.accountName}
                    </div>
                    <div className="font-mono text-mono text-muted-foreground">
                      {row.billingAccountId}
                    </div>
                  </td>
                  <td className="px-4 py-3 align-top">
                    <InfoBadge label={row.reason} />
                  </td>
                  <td className="px-4 py-3 align-top whitespace-nowrap text-muted-foreground">
                    {formatCalendarDate(row.windowStart)} –{" "}
                    {formatCalendarDate(row.windowEnd)}
                  </td>
                  <td className="px-4 py-3 text-right align-top whitespace-nowrap text-muted-foreground tabular-nums">
                    {row.indicativeValue ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-right align-top whitespace-nowrap">
                    {canRecover ? (
                      <Link
                        href={transactionsHref(row)}
                        className="inline-flex items-center gap-1 text-body-sm font-medium text-[color:var(--color-info-700)] hover:underline"
                      >
                        Manual DBN/ADJ
                        <ArrowUpRight size={14} aria-hidden="true" />
                      </Link>
                    ) : (
                      <span
                        className="text-body-sm text-muted-foreground"
                        title="Requires Transactions access to recover"
                      >
                        Manual DBN/ADJ
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ExceptionsSection({
  exceptions,
  locale,
}: {
  exceptions: ExceptionRow[];
  locale: string;
}): React.JSX.Element {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-body font-semibold text-foreground">Exceptions</h2>
        <p className="text-body-sm text-muted-foreground">
          {exceptions.length === 0
            ? "No per-record exceptions this run — no not-used usage and no orphaned records."
            : `${exceptions.length} per-record exception${exceptions.length === 1 ? "" : "s"} — informational; these records are not on any bill.`}
        </p>
      </div>

      {exceptions.length === 0 ? (
        <div className="rounded-none bg-card p-10 text-center shadow-sm">
          <CircleCheck
            className="mx-auto mb-3 size-10 text-[color:var(--color-success-500)]"
            aria-hidden="true"
          />
          <p className="text-body font-semibold text-foreground">
            No exceptions
          </p>
          <p className="mt-1 text-body-sm text-muted-foreground">
            Every rated usage record was either billed or excluded at scoping.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-none border-l-2 border-[color:var(--color-info-500)] bg-card shadow-sm">
          <table className="w-full border-collapse text-body-sm">
            <thead>
              <tr className="border-b border-border bg-[color:var(--surface-sunken)]">
                <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                  Kind
                </th>
                <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                  Account
                </th>
                <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                  Usage type
                </th>
                <th className="px-4 py-3 text-right text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                  Quantity
                </th>
                <th className="px-4 py-3 text-right text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                  Rated value
                </th>
              </tr>
            </thead>
            <tbody>
              {exceptions.map((row, index) => (
                <tr
                  key={`${row.kind}-${row.subscriberRef}-${index}`}
                  className="border-b border-[color:var(--border-subtle)] hover:bg-[color:var(--color-neutral-50)]"
                >
                  <td className="px-4 py-3 align-top">
                    <InfoBadge
                      label={
                        row.kind === "BILL_NOTUSED" ? "Not used" : "Orphan"
                      }
                    />
                  </td>
                  <td className="px-4 py-3 align-top">
                    {row.accountName ? (
                      <div className="font-medium text-foreground">
                        {row.accountName}
                      </div>
                    ) : (
                      <div className="font-medium text-muted-foreground italic">
                        Unresolvable subscriber
                      </div>
                    )}
                    <div className="font-mono text-mono text-muted-foreground">
                      {row.subscriberRef}
                    </div>
                  </td>
                  <td className="px-4 py-3 align-top whitespace-nowrap text-muted-foreground">
                    {row.udrType}
                  </td>
                  <td className="px-4 py-3 text-right align-top whitespace-nowrap text-muted-foreground tabular-nums">
                    {row.quantity} {row.unit}
                  </td>
                  <td className="px-4 py-3 text-right align-top whitespace-nowrap text-muted-foreground tabular-nums">
                    {formatCurrency(row.ratedPrice, row.currency, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function UnchargedTable({
  runId,
  rows,
  exceptions,
  canRecover,
  locale,
}: UnchargedTableProps): React.JSX.Element {
  return (
    <div className="space-y-8">
      <UnchargedAccountsSection
        runId={runId}
        rows={rows}
        canRecover={canRecover}
      />
      <ExceptionsSection exceptions={exceptions} locale={locale} />
    </div>
  );
}
