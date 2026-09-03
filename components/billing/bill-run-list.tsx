// bm02-spec §6 (Design §Structural). The two-tab run list: Current & Upcoming
// (operable + upcoming runs grouped by cycle, the operable one surfaced as a
// `RunActionCard`) and Historical (terminal runs, read-only, filterable +
// paginated + CSV-exportable). Server component; the tab switch is a `<Link>`
// (view state in the URL, code-standards §3.3). Empty states are first-class,
// not blank tabs (code-standards §4.8).

import Link from "next/link";
import { FolderOpen, type LucideIcon } from "lucide-react";

import {
  BillRunsFilters,
  type CycleOption,
} from "@/components/billing/bill-runs-filters";
import { BillRunsEmptyState } from "@/components/billing/bill-runs-empty-state";
import { BillRunsPagination } from "@/components/billing/bill-runs-pagination";
import { ExportRunsButton } from "@/components/billing/export-runs-button";
import { RunActionCard } from "@/components/billing/run-action-card";
import { RunStatusBadge } from "@/components/billing/run-status-badge";
import { PlaceholderBadge } from "@/components/billing/placeholder-banner";
import { formatCalendarDate } from "@/lib/formatters";
import type { RunListPage, RunListRow } from "@/types/billing";

interface BillRunListProps {
  page: RunListPage;
  cycles: CycleOption[];
  hasCycles: boolean;
  placeholderMode: boolean;
  // The active filters, so a tab switch preserves them (cycle applies to both
  // tabs; status is Historical-only). Page always resets to 1 (by omission).
  activeCycle: string | null;
  activeStatus: string | null;
}

const TABS = [
  { key: "current", label: "Current & Upcoming" },
  { key: "historical", label: "Historical" },
] as const;

function tabHref(
  tab: "current" | "historical",
  activeCycle: string | null,
  activeStatus: string | null,
): string {
  const params = new URLSearchParams();
  params.set("tab", tab);
  if (activeCycle) params.set("cycle", activeCycle);
  // Status only makes sense on Historical; dropping it on Current keeps the
  // operability resolution over the full non-terminal set.
  if (tab === "historical" && activeStatus) params.set("status", activeStatus);
  return `?${params.toString()}`;
}

export function BillRunList({
  page,
  cycles,
  hasCycles,
  placeholderMode,
  activeCycle,
  activeStatus,
}: BillRunListProps): React.JSX.Element {
  return (
    <div className="space-y-4">
      <nav
        aria-label="Bill run tabs"
        className="flex gap-1 border-b border-border"
      >
        {TABS.map((t) => {
          const active = page.tab === t.key;
          return (
            <Link
              key={t.key}
              href={tabHref(t.key, activeCycle, activeStatus)}
              aria-current={active ? "page" : undefined}
              className={
                active
                  ? "border-b-2 border-[color:var(--color-primary-500)] px-4 py-2 text-body-sm font-semibold text-foreground"
                  : "border-b-2 border-transparent px-4 py-2 text-body-sm font-medium text-muted-foreground hover:text-foreground"
              }
            >
              {t.label}
            </Link>
          );
        })}
      </nav>

      {/* Re-mount on any filter/tab change so the draft selects re-seed from
          the fresh URL (no setState-in-effect resync). */}
      <BillRunsFilters
        key={`${page.tab}:${activeCycle ?? ""}:${activeStatus ?? ""}`}
        cycles={cycles}
        tab={page.tab}
      />

      {page.tab === "current" ? (
        <CurrentAndUpcoming
          rows={page.rows}
          hasCycles={hasCycles}
          placeholderMode={placeholderMode}
        />
      ) : (
        <Historical page={page} placeholderMode={placeholderMode} />
      )}
    </div>
  );
}

interface CycleGroup {
  cycleId: string;
  cycleName: string;
  rows: RunListRow[];
}

function groupByCycle(rows: RunListRow[]): CycleGroup[] {
  const groups: CycleGroup[] = [];
  const index = new Map<string, number>();
  for (const row of rows) {
    let i = index.get(row.cycleId);
    if (i === undefined) {
      i = groups.length;
      index.set(row.cycleId, i);
      groups.push({ cycleId: row.cycleId, cycleName: row.cycleName, rows: [] });
    }
    groups[i]!.rows.push(row);
  }
  return groups;
}

function CurrentAndUpcoming({
  rows,
  hasCycles,
  placeholderMode,
}: {
  rows: RunListRow[];
  hasCycles: boolean;
  placeholderMode: boolean;
}): React.JSX.Element {
  if (rows.length === 0) {
    // Reuse the bm01 empty-state component for the "no runs" case
    // (bm02-spec §5); the "no cycles" case links to Accounts settings.
    return hasCycles ? (
      <BillRunsEmptyState />
    ) : (
      <EmptyState
        icon={FolderOpen}
        title="No bill cycles configured"
        body="Bill runs are derived from active bill cycles. Add one in Accounts settings to get started."
        action={
          <Link
            href="/administration/accounts-settings"
            className="text-body-sm font-semibold text-[color:var(--color-primary-600)] hover:underline"
          >
            Go to Accounts settings →
          </Link>
        }
      />
    );
  }

  const groups = groupByCycle(rows);

  return (
    <div className="space-y-6">
      {groups.map((group) => {
        const operable = group.rows.find((r) => r.operable);
        const others = group.rows.filter((r) => !r.operable);
        return (
          <section key={group.cycleId} className="space-y-3">
            <h2 className="text-body font-semibold text-foreground">
              {group.cycleName}
            </h2>
            {operable && (
              <RunActionCard run={operable} placeholderMode={placeholderMode} />
            )}
            {others.length > 0 && (
              <div className="overflow-hidden rounded-md bg-card shadow-sm">
                <RunsTable
                  rows={others}
                  placeholderMode={placeholderMode}
                  showCycle={false}
                  showReason
                />
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function Historical({
  page,
  placeholderMode,
}: {
  page: RunListPage;
  placeholderMode: boolean;
}): React.JSX.Element {
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <ExportRunsButton tab="historical" />
      </div>
      {page.rows.length === 0 ? (
        <EmptyState
          icon={FolderOpen}
          title="No historical runs"
          body="Completed and cancelled runs will appear here. This is a normal state, not an error."
        />
      ) : (
        <div className="overflow-hidden rounded-md bg-card shadow-sm">
          <RunsTable
            rows={page.rows}
            placeholderMode={placeholderMode}
            showCycle
            showReason={false}
          />
          {page.total > page.pageSize && (
            <div className="px-4 pb-4">
              <BillRunsPagination
                total={page.total}
                page={page.page}
                pageSize={page.pageSize}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RunsTable({
  rows,
  placeholderMode,
  showCycle,
  showReason,
}: {
  rows: RunListRow[];
  placeholderMode: boolean;
  showCycle: boolean;
  showReason: boolean;
}): React.JSX.Element {
  const headerClass =
    "px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase";
  return (
    <table className="w-full border-collapse text-body">
      <thead>
        <tr className="border-b border-border bg-[color:var(--surface-sunken)]">
          <th className={headerClass}>Run ID</th>
          {showCycle && <th className={headerClass}>Cycle</th>}
          <th className={headerClass}>Period</th>
          <th className={headerClass}>Scheduled run date</th>
          <th className={headerClass}>Status</th>
          {showReason ? (
            <th className={headerClass}>Note</th>
          ) : (
            <th className={headerClass}>Run type</th>
          )}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.billRunId}
            className="border-b border-[color:var(--border-subtle)] hover:bg-[color:var(--color-neutral-50)]"
          >
            <td className="px-4 py-3 whitespace-nowrap">
              <span className="font-mono text-mono text-foreground">
                {row.billRunId}
              </span>
            </td>
            {showCycle && (
              <td className="px-4 py-3 text-body-sm text-foreground">
                {row.cycleName}
              </td>
            )}
            <td className="px-4 py-3 text-body-sm whitespace-nowrap text-muted-foreground">
              {formatCalendarDate(row.periodStart)} –{" "}
              {formatCalendarDate(row.periodEnd)}
            </td>
            <td className="px-4 py-3 text-body-sm whitespace-nowrap text-muted-foreground">
              {formatCalendarDate(row.scheduledRunDate)}
            </td>
            <td className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <RunStatusBadge status={row.status} />
                {placeholderMode && <PlaceholderBadge />}
              </div>
            </td>
            {showReason ? (
              <td className="px-4 py-3 text-body-sm text-muted-foreground">
                {!row.pastDue
                  ? `Period closes ${formatCalendarDate(row.scheduledRunDate)}`
                  : "—"}
              </td>
            ) : (
              <td className="px-4 py-3 text-body-sm text-muted-foreground">
                {row.runType}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EmptyState({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="rounded-md bg-card p-10 text-center shadow-sm">
      <Icon
        aria-hidden
        className="mx-auto mb-3 size-10 text-[color:var(--text-muted)]"
      />
      <h3 className="text-body font-semibold text-foreground">{title}</h3>
      <p className="mx-auto mt-2 max-w-md text-body-sm text-muted-foreground">
        {body}
      </p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
