// bm07-spec §Visual — the Uncharged tab: the run's deliberately-not-billed
// accounts (`EXCLUDED`, a scoping-time partial-period exclusion). Info/neutral
// "revenue queue" treatment (never the destructive Errors styling —
// code-standards §4.7): these are not failures, they are accounts to recover
// via a manual DBN/ADJ. Per row: account, reason, uncharged window, indicative
// value ("—" in v1 — no rating source), and a deep link to Accounts →
// Transactions carrying the account context. Server component (a native table
// + `<Link>`, no interaction leaf beyond the CSV button). Zero exceptions is a
// positive empty state, not a blank tab.

import { ArrowUpRight, CircleCheck } from "lucide-react";
import Link from "next/link";

import { ExportUnchargedButton } from "@/components/billing/export-uncharged-button";
import { formatCalendarDate } from "@/lib/formatters";
import type { UnchargedRow } from "@/types/billing";

export interface UnchargedTableProps {
  runId: string;
  rows: UnchargedRow[];
  // Whether the viewer can reach Accounts → Transactions (gated by
  // `accounts_transactions:READ`). When false the recovery link would dead-end
  // at /no-access, so it renders as a plain, non-linking hint instead.
  canRecover: boolean;
}

function transactionsHref(row: UnchargedRow): string {
  const params = new URLSearchParams({
    fa: row.financialAccountId,
    ban: row.billingAccountId,
  });
  return `/accounts/transactions?${params.toString()}`;
}

export function UnchargedTable({
  runId,
  rows,
  canRecover,
}: UnchargedTableProps): React.JSX.Element {
  if (rows.length === 0) {
    return (
      <div className="rounded-none bg-card p-10 text-center shadow-sm">
        <CircleCheck
          className="mx-auto mb-3 size-10 text-[color:var(--color-success-500)]"
          aria-hidden="true"
        />
        <p className="text-body font-semibold text-foreground">
          No uncharged accounts
        </p>
        <p className="mt-1 text-body-sm text-muted-foreground">
          Every scoped account was billed this run — nothing was excluded for a
          partial period.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-body-sm text-muted-foreground">
          {rows.length} account{rows.length === 1 ? "" : "s"} excluded this run
          — recover each via a manual DBN/ADJ against the account.
        </p>
        <ExportUnchargedButton runId={runId} />
      </div>

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
                  <span className="inline-flex items-center rounded-full bg-[color:var(--color-info-50)] px-2 py-0.5 text-[11px] font-semibold tracking-wider text-[color:var(--color-info-700)] uppercase">
                    {row.reason}
                  </span>
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
    </div>
  );
}
