// ac13-spec §3.1 — GL Journal page: period selector, period-movement /
// trial-balance summary table, balanced Σ total row (V6), expandable
// drill-down to source entries. Read-only; export/close are ac14.

import { Fragment } from "react";

import type { Metadata } from "next";
import Link from "next/link";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { AmountCell } from "@/components/accounts/amount-cell";
import { ClosePeriodButton } from "@/components/accounts/close-period-button";
import { JournalExportButton } from "@/components/accounts/journal-export-button";
import { LedgerKindChip } from "@/components/accounts/ledger-kind-chip";
import { cn } from "@/lib/utils";
import {
  getPeriodSummary,
  getCodeDrilldown,
} from "@/services/accounts/gl-journal";
import { getPeriodState } from "@/services/accounts/period-close";
import type { LedgerAccountKind } from "@/types/accounts";
import { meetsLevel } from "@/types/permissions";
import { glJournalSearchParamsSchema } from "@/validation/accounts/gl-journal-search-params.schema";
import type { GlJournalSort } from "@/services/accounts/gl-journal";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "GL Journal" };

// gl_journal_view has no currency column; amounts are reported in the system
// currency. AmountCell uses this constant for its currency-code prefix only.
const DISPLAY_CURRENCY = "MYR";

// Derive the account kind (ban/fa/sys) from a pgledger account name so the
// LedgerKindChip can render correctly in the drill-down (ac06 rendering reuse).
function accountKind(name: string): LedgerAccountKind {
  if (name.startsWith("ban.")) return "ban";
  if (name.startsWith("fa.")) return "fa";
  return "sys";
}

// Build a URL that preserves all current params but overrides specific keys.
function buildUrl(
  base: Record<string, string | undefined>,
  overrides: Record<string, string | undefined>,
): string {
  const merged = { ...base, ...overrides };
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) {
    if (v !== undefined && v !== "") params.set(k, v);
  }
  const qs = params.toString();
  return `/accounts/gl-journal${qs ? `?${qs}` : ""}`;
}

// Sort-column header: toggles direction when clicking the active column.
// aria-sort communicates the current sort direction to assistive technology.
function SortHeader({
  label,
  colSort,
  currentSort,
  baseParams,
  className,
}: {
  label: string;
  colSort: GlJournalSort;
  currentSort: GlJournalSort;
  baseParams: Record<string, string | undefined>;
  className?: string;
}): React.JSX.Element {
  const isActive =
    currentSort === colSort || currentSort === (`-${colSort}` as GlJournalSort);
  const isDesc = currentSort === (`-${colSort}` as GlJournalSort);
  const nextSort: GlJournalSort =
    isActive && !isDesc ? (`-${colSort}` as GlJournalSort) : colSort;

  return (
    <th
      className={className}
      aria-sort={isActive ? (isDesc ? "descending" : "ascending") : "none"}
    >
      <Link
        href={buildUrl(baseParams, { sort: nextSort })}
        className="inline-flex items-center gap-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase hover:text-foreground"
      >
        {label}
        {isActive && (
          <span aria-hidden className="text-[9px]">
            {isDesc ? "▼" : "▲"}
          </span>
        )}
      </Link>
    </th>
  );
}

export default async function GlJournalPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { permissionMap } = await requirePermission(
    PERMISSIONS.ACCOUNTS_CONFIG,
    LEVELS.READ,
  );
  const canEdit = meetsLevel(
    permissionMap[PERMISSIONS.ACCOUNTS_CONFIG],
    LEVELS.EDIT,
  );

  const rawParams = await searchParams;
  // Flatten string[] → string (take first value) before validating.
  const flatParams: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(rawParams)) {
    flatParams[k] = Array.isArray(v) ? (v[0] ?? undefined) : v;
  }

  const { period, view, sort, expand } =
    glJournalSearchParamsSchema.parse(flatParams);

  // Base params dict for URL builders (all current params minus what we're changing).
  const baseParams: Record<string, string | undefined> = {
    period,
    view,
    sort,
    expand,
  };

  const [summary, drilldown, periodState] = await Promise.all([
    getPeriodSummary(period, view, sort),
    expand ? getCodeDrilldown(expand, period, view) : Promise.resolve(null),
    canEdit
      ? getPeriodState(period, DISPLAY_CURRENCY)
      : Promise.resolve("open" as const),
  ]);

  const { rows, totals } = summary;
  const totalRowBroken = !totals.balanced;

  // Formatted period display: "July 2026"
  const [yearStr, monthStr] = period.split("-");
  const periodLabel = new Date(
    Number(yearStr),
    Number(monthStr) - 1,
    1,
  ).toLocaleString("en-MY", { month: "long", year: "numeric" });

  return (
    <main className="space-y-6 p-6">
      <header>
        <h1 className="text-h1 font-semibold text-foreground">GL Journal</h1>
        <p className="mt-1 text-body text-muted-foreground">
          Period journal entries by GL code — drill down to source ledger
          entries.
        </p>
      </header>

      {/* ── Period selector (P5.1) ─────────────────────────────────────────── */}
      <form
        method="GET"
        action="/accounts/gl-journal"
        className="flex flex-wrap items-end gap-3"
      >
        <div className="flex flex-col gap-1">
          <label
            htmlFor="period"
            className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
          >
            Period
          </label>
          <input
            id="period"
            name="period"
            type="month"
            defaultValue={period}
            className="rounded-sm border border-[color:var(--border-default)] bg-[color:var(--surface-card)] px-3 py-1.5 text-body text-foreground focus:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
          />
        </div>

        {/* Preserve view and sort across period changes */}
        <input type="hidden" name="view" value={view} />
        <input type="hidden" name="sort" value={sort} />

        <button
          type="submit"
          className="rounded-sm bg-[color:var(--action-primary-bg)] px-4 py-1.5 text-body font-medium text-[color:var(--action-primary-fg)] hover:bg-[color:var(--action-primary-hover)] focus:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
        >
          Apply
        </button>
      </form>

      {/* ── Period actions: close + export (ac14, accounts_config:EDIT) ─────── */}
      {canEdit && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-body-sm text-muted-foreground">
            {periodLabel}:{" "}
            <strong>{periodState === "closed" ? "Closed" : "Open"}</strong>
          </span>
          {periodState === "open" && (
            <ClosePeriodButton
              period={period}
              currency={DISPLAY_CURRENCY}
              periodLabel={periodLabel}
            />
          )}
          <JournalExportButton period={period} currency={DISPLAY_CURRENCY} />
        </div>
      )}

      {/* ── View toggle (P5.5) ─────────────────────────────────────────────── */}
      <div
        className="flex items-center gap-2"
        role="group"
        aria-label="Journal view"
      >
        <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
          View
        </span>
        <Link
          href={buildUrl(baseParams, { view: "movement", expand: undefined })}
          aria-current={view === "movement" ? "true" : undefined}
          className={[
            "rounded-sm border px-3 py-1 text-body-sm font-medium transition-colors",
            view === "movement"
              ? "border-[color:var(--action-primary-bg)] bg-[color:var(--action-primary-bg)] text-[color:var(--action-primary-fg)]"
              : "border-[color:var(--border-default)] bg-[color:var(--surface-card)] text-foreground hover:bg-[color:var(--surface-sunken)]",
          ].join(" ")}
        >
          Period Movement
        </Link>
        <Link
          href={buildUrl(baseParams, { view: "trial", expand: undefined })}
          aria-current={view === "trial" ? "true" : undefined}
          className={[
            "rounded-sm border px-3 py-1 text-body-sm font-medium transition-colors",
            view === "trial"
              ? "border-[color:var(--action-primary-bg)] bg-[color:var(--action-primary-bg)] text-[color:var(--action-primary-fg)]"
              : "border-[color:var(--border-default)] bg-[color:var(--surface-card)] text-foreground hover:bg-[color:var(--surface-sunken)]",
          ].join(" ")}
        >
          Trial Balance (Cumulative)
        </Link>
      </div>

      {/* ── Journal summary table (P5.2 — V6) ────────────────────────────── */}
      <section className="space-y-2">
        <h2 className="text-h3 font-semibold text-foreground">
          {periodLabel} —{" "}
          {view === "movement" ? "Period Movement" : "Trial Balance"}
        </h2>

        <div className="overflow-x-auto rounded-md border border-[color:var(--border-default)]">
          <table className="min-w-full text-body-sm">
            <thead>
              <tr className="border-b border-[color:var(--border-subtle)] bg-[color:var(--surface-sunken)]">
                <th className="px-4 py-2 text-left text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                  GL Code
                </th>
                <th className="px-4 py-2 text-left text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                  Account Name
                </th>
                {/* Debit vs credit communicated by column position, never color
                    (ui-context §3, spec §2.2) */}
                <SortHeader
                  label="Debit"
                  colSort="debit"
                  currentSort={sort}
                  baseParams={baseParams}
                  className="px-4 py-2 text-right"
                />
                <SortHeader
                  label="Credit"
                  colSort="credit"
                  currentSort={sort}
                  baseParams={baseParams}
                  className="px-4 py-2 text-right"
                />
                <th className="px-4 py-2" aria-label="Drill-down" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--border-subtle)]">
              {rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-8 text-center text-body text-muted-foreground"
                  >
                    No journal entries for {periodLabel}.
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const isExpanded = expand === row.glCode;
                  const expandHref = isExpanded
                    ? buildUrl(baseParams, { expand: undefined })
                    : buildUrl(baseParams, { expand: row.glCode });

                  return (
                    <Fragment key={row.glCode}>
                      <tr className="bg-[color:var(--surface-card)] hover:bg-[color:var(--surface-sunken)]">
                        <td className="px-4 py-2 font-mono text-foreground">
                          {row.glCode}
                        </td>
                        <td className="px-4 py-2 text-foreground">
                          {row.name}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <AmountCell
                            amount={row.debit}
                            currency={DISPLAY_CURRENCY}
                          />
                        </td>
                        <td className="px-4 py-2 text-right">
                          <AmountCell
                            amount={row.credit}
                            currency={DISPLAY_CURRENCY}
                          />
                        </td>
                        <td className="px-4 py-2 text-right">
                          <Link
                            href={expandHref}
                            aria-expanded={isExpanded}
                            aria-label={`${isExpanded ? "Collapse" : "Expand"} drill-down for GL ${row.glCode}`}
                            className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
                          >
                            {isExpanded ? "▲" : "▼"}
                          </Link>
                        </td>
                      </tr>

                      {/* ── Drill-down expansion (P5.3) ─────────────────────── */}
                      {isExpanded && drilldown && (
                        <tr className="bg-[color:var(--surface-sunken)]">
                          <td colSpan={5} className="p-0">
                            <div className="border-t border-[color:var(--border-subtle)] px-6 py-3">
                              <p className="mb-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                                Source entries — GL {row.glCode} · {row.name}
                              </p>
                              {drilldown.entries.length === 0 ? (
                                <p className="text-body-sm text-muted-foreground">
                                  No entries for this GL code in the selected
                                  scope.
                                </p>
                              ) : (
                                <>
                                  <table className="min-w-full text-body-sm">
                                    <thead>
                                      <tr className="border-b border-[color:var(--border-subtle)]">
                                        <th className="pr-4 pb-1 text-left text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                                          Account
                                        </th>
                                        <th className="pr-4 pb-1 text-left text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                                          Kind
                                        </th>
                                        <th className="pr-4 pb-1 text-left text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                                          Date
                                        </th>
                                        <th className="pr-4 pb-1 text-left text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                                          Document
                                        </th>
                                        <th className="pb-1 text-right text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                                          Amount
                                        </th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-[color:var(--border-subtle)]">
                                      {drilldown.entries.map((entry) => (
                                        <tr key={entry.entryId}>
                                          <td className="py-1.5 pr-4 font-mono text-foreground">
                                            {entry.accountName}
                                          </td>
                                          <td className="py-1.5 pr-4">
                                            <LedgerKindChip
                                              kind={accountKind(
                                                entry.accountName,
                                              )}
                                            />
                                          </td>
                                          <td className="py-1.5 pr-4 text-muted-foreground">
                                            {entry.eventAt
                                              .toISOString()
                                              .slice(0, 10)}
                                          </td>
                                          <td className="py-1.5 pr-4 font-mono text-muted-foreground">
                                            {entry.docId ?? "—"}
                                          </td>
                                          <td className="py-1.5 text-right">
                                            <AmountCell
                                              amount={entry.amount}
                                              currency={DISPLAY_CURRENCY}
                                            />
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                  {drilldown.truncated && (
                                    <p className="mt-2 text-body-sm text-muted-foreground">
                                      Showing first 500 entries — export the
                                      full set via the CSV download (ac14).
                                    </p>
                                  )}
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })
              )}
            </tbody>

            {/* ── Σ total row (V6 — ui-context §3) ─────────────────────────── */}
            <tfoot>
              <tr
                className={[
                  "border-t-2 border-[color:var(--border-default)]",
                  totalRowBroken
                    ? "bg-[color:var(--acct-balance-broken)]"
                    : "bg-[color:var(--surface-sunken)]",
                ].join(" ")}
              >
                <td
                  colSpan={2}
                  className={cn(
                    "px-4 py-2.5 text-[15px] font-semibold tabular-nums",
                    totalRowBroken
                      ? "text-[color:var(--text-on-brand)]"
                      : "text-foreground",
                  )}
                >
                  {totalRowBroken
                    ? "⚠ Σ Debit ≠ Σ Credit — journal is unbalanced"
                    : "Total"}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <AmountCell
                    amount={totals.totalDebit}
                    currency={DISPLAY_CURRENCY}
                    className={cn(
                      "text-h4",
                      totalRowBroken && "text-[color:var(--text-on-brand)]",
                    )}
                  />
                </td>
                <td className="px-4 py-2.5 text-right">
                  <AmountCell
                    amount={totals.totalCredit}
                    currency={DISPLAY_CURRENCY}
                    className={cn(
                      "text-h4",
                      totalRowBroken && "text-[color:var(--text-on-brand)]",
                    )}
                  />
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>

        {/* Balance status strip — outside the table so live-region semantics
            are not constrained by table cell / row ARIA roles (spec §2.2). */}
        {rows.length > 0 && totalRowBroken && (
          <p
            role="alert"
            className="text-body-sm font-medium text-[color:var(--acct-balance-broken)]"
          >
            ⚠ Σ Debit ≠ Σ Credit — journal is unbalanced
          </p>
        )}
        {rows.length > 0 && !totalRowBroken && (
          <p className="text-body-sm font-medium text-[color:var(--acct-balance-ok)]">
            ✓ Balanced — Σ debit = Σ credit = {totals.totalDebit}
          </p>
        )}
      </section>
    </main>
  );
}
