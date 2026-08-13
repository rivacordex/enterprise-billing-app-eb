"use client";

import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Handshake,
  Layers,
  Pencil,
  PauseCircle,
  PlayCircle,
  XCircle,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

import { EditCharacteristicsDialog } from "@/components/products/inventory/edit-characteristics-dialog";
import { ResumeDialog } from "@/components/products/inventory/resume-dialog";
import { StatusHistoryRows } from "@/components/products/inventory/status-history-rows";
import {
  SUBSCRIPTION_STATUS_LABELS,
  SubscriptionStatusBadge,
} from "@/components/products/inventory/subscription-status-badge";
import { SuspendDialog } from "@/components/products/inventory/suspend-dialog";
import { TerminateDialog } from "@/components/products/inventory/terminate-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  PRODUCT_STATUSES,
  type ProductStatus,
  type SubscriptionDetail,
  type SubscriptionListRow,
} from "@/types/inventory";
import type { SUBSCRIPTION_SORT_VALUES } from "@/validation/inventory/subscriptions-list.schema";

type SubscriptionSort = (typeof SUBSCRIPTION_SORT_VALUES)[number];
type SortColumn = "product_inventory_id" | "start_date" | "status";

const TABLE_COLUMN_COUNT = 10;

const ACTION_BUTTON_CLASS =
  "inline-flex size-7 items-center justify-center rounded-sm border-[0.5px] border-[color:var(--border)] outline-none focus-visible:[box-shadow:var(--focus-ring)]";

interface SubscriptionsTableProps {
  rows: SubscriptionListRow[];
  total: number;
  page: number;
  pageSize: number;
  selectedInventoryId: string | null;
  detail: SubscriptionDetail | null;
  canEdit: boolean;
  query: string;
  status: ProductStatus | null;
  sort: SubscriptionSort;
  locale: string;
  timezone: string;
}

function parseSort(sort: SubscriptionSort): {
  column: string;
  dir: "asc" | "desc";
} {
  if (sort.startsWith("-")) {
    return { column: sort.slice(1), dir: "desc" };
  }
  return { column: sort, dir: "asc" };
}

// pm33-spec §Implementation-1/2. `SubscriptionsTable`: the guarded inventory
// list — Orders page's search/sort/filter/pagination pattern (pm27) plus
// Manage Products' per-row chevron expand (pm18/§7) rather than Orders'
// whole-row-click selection, since the expand target here is a status-history
// sub-row, not a side panel. Row actions are status-gated per pm32's
// transition matrix; a TERMINATED row shows the catalog's RETIRED-row
// convention. `locale`/`timezone` are accepted for forward-compat with a
// future formatted-timestamp column (manage-offering-table.tsx precedent) —
// start/end are plain `date` columns (calendar days), rendered as-is —
// deliberately not destructured, so they're threaded through the prop
// contract without an unused-variable lint hit.
export function SubscriptionsTable({
  rows,
  total,
  page,
  pageSize,
  selectedInventoryId,
  detail,
  canEdit,
  query,
  status,
  sort,
}: SubscriptionsTableProps): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [searchInput, setSearchInput] = useState(query);
  // Render-time prop sync (offering-table/orders-table precedent) — avoids
  // the `react-hooks/set-state-in-effect` lint rule an effect-based sync
  // trips.
  const [prevQuery, setPrevQuery] = useState(query);
  if (query !== prevQuery) {
    setPrevQuery(query);
    setSearchInput(query);
  }

  const { column: activeColumn, dir: activeDir } = parseSort(sort);
  const totalPages = Math.ceil(total / pageSize);

  function navigate(mutate: (params: URLSearchParams) => void, push = false) {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    const url = `${pathname}?${params.toString()}`;
    startTransition(() => {
      if (push) {
        router.push(url);
      } else {
        router.replace(url);
      }
    });
  }

  function applySearch(next: string): void {
    navigate((params) => {
      if (next) {
        params.set("q", next);
      } else {
        params.delete("q");
      }
      params.set("page", "1");
    });
  }

  function clearSearch(): void {
    setSearchInput("");
    navigate((params) => {
      params.delete("q");
      params.set("page", "1");
    });
  }

  function applyStatus(next: ProductStatus | ""): void {
    navigate((params) => {
      if (next) {
        params.set("status", next);
      } else {
        params.delete("status");
      }
      params.set("page", "1");
    });
  }

  function applySort(column: SortColumn): void {
    const nextSort =
      column === activeColumn && activeDir === "asc" ? `-${column}` : column;
    navigate((params) => {
      params.set("sort", nextSort);
      params.set("page", "1");
    });
  }

  function goToPage(target: number): void {
    navigate((params) => {
      params.set("page", String(target));
    });
  }

  // Toggles the single URL-driven expanded row — clicking the chevron on the
  // currently expanded row collapses it (removes the param); clicking any
  // other row's chevron switches the expansion to it (pm33-spec §Design —
  // `subscription` is "selected/expanded row", same single-selection deep-
  // link convention as View Product's `?offering=`).
  function toggleSubscription(inventoryId: string): void {
    navigate((params) => {
      if (selectedInventoryId === inventoryId) {
        params.delete("subscription");
      } else {
        params.set("subscription", inventoryId);
      }
    }, true);
  }

  return (
    <div className="rounded-md bg-card shadow-sm">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="sr-only" htmlFor="subscription-search">
              Search subscriptions by customer or subscription ID
            </label>
            <input
              id="subscription-search"
              aria-label="Search subscriptions by customer or subscription ID"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  applySearch(searchInput);
                }
              }}
              disabled={isPending}
              className="h-9 w-56 rounded-sm border border-border bg-card px-3 text-body text-foreground focus:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
            />
          </div>

          <Button onClick={() => applySearch(searchInput)} disabled={isPending}>
            Apply
          </Button>
          {query !== "" && (
            <Button
              variant="outline"
              onClick={clearSearch}
              disabled={isPending}
            >
              Clear
            </Button>
          )}

          <div className="flex flex-col gap-1">
            <label className="sr-only" htmlFor="subscription-status-filter">
              Filter by subscription status
            </label>
            <select
              id="subscription-status-filter"
              aria-label="Filter by subscription status"
              value={status ?? ""}
              onChange={(e) =>
                applyStatus(e.target.value as ProductStatus | "")
              }
              disabled={isPending}
              className="h-9 w-48 rounded-sm border border-border bg-card px-3 text-body text-foreground focus:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
            >
              <option value="">All statuses</option>
              {PRODUCT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {SUBSCRIPTION_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div
        className={cn(
          "overflow-x-auto",
          isPending && "opacity-60 transition-opacity",
        )}
      >
        <table className="w-full border-collapse text-body">
          <thead>
            <tr className="border-b border-border bg-[color:var(--surface-sunken)]">
              <th className="w-10 px-2 py-3" aria-hidden />
              <SortableHeader
                column="product_inventory_id"
                label="Subscription"
                activeColumn={activeColumn}
                activeDir={activeDir}
                isPending={isPending}
                onSort={applySort}
              />
              <Header label="Customer" />
              <Header label="BAN" />
              <Header label="Offer" />
              <Header label="Qty" />
              <SortableHeader
                column="start_date"
                label="Start"
                activeColumn={activeColumn}
                activeDir={activeDir}
                isPending={isPending}
                onSort={applySort}
              />
              <Header label="End" />
              <SortableHeader
                column="status"
                label="Status"
                activeColumn={activeColumn}
                activeDir={activeDir}
                isPending={isPending}
                onSort={applySort}
              />
              <Header label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={TABLE_COLUMN_COUNT}
                  className="bg-[color:var(--surface-sunken)] py-16 text-center"
                >
                  <Layers className="mx-auto mb-3 size-12 text-[color:var(--text-muted)]" />
                  <p className="text-body text-muted-foreground">
                    No subscriptions match your filters
                  </p>
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const isExpanded = row.inventoryId === selectedInventoryId;
                return (
                  <SubscriptionRow
                    key={row.inventoryId}
                    row={row}
                    isExpanded={isExpanded}
                    detail={isExpanded ? detail : null}
                    canEdit={canEdit}
                    onToggle={() => toggleSubscription(row.inventoryId)}
                  />
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {total > 0 && (
        <div className="flex items-center justify-between border-t border-[color:var(--border-subtle)] px-4 py-4">
          {rows.length > 0 ? (
            <span className="text-body text-muted-foreground">
              Showing {(page - 1) * pageSize + 1}–
              {Math.min(page * pageSize, total)} of {total} subscriptions
            </span>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => goToPage(page - 1)}
              disabled={page <= 1 || isPending}
              aria-label="Previous page"
              className="rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:[box-shadow:var(--focus-ring)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ChevronLeft className="size-4" />
            </button>
            <span className="px-2 text-body text-muted-foreground">
              Page {page} of {totalPages || 1}
            </span>
            <button
              type="button"
              onClick={() => goToPage(page + 1)}
              disabled={page >= totalPages || isPending}
              aria-label="Next page"
              className="rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:[box-shadow:var(--focus-ring)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SubscriptionRow({
  row,
  isExpanded,
  detail,
  canEdit,
  onToggle,
}: {
  row: SubscriptionListRow;
  isExpanded: boolean;
  detail: SubscriptionDetail | null;
  canEdit: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const isTerminated = row.status === "TERMINATED";

  return (
    <>
      <tr
        className={cn(
          "border-b border-[color:var(--border-subtle)] last:border-0",
          isTerminated && "text-[color:var(--text-muted)]",
          isExpanded && "bg-[color:var(--surface-selected)]",
        )}
      >
        <td className="w-10 px-2 py-2">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={isExpanded}
            aria-label={
              isExpanded
                ? `Hide status history for ${row.inventoryId}`
                : `Show status history for ${row.inventoryId}`
            }
            className="flex size-6 items-center justify-center text-[color:var(--text-muted)]"
          >
            {isExpanded ? (
              <ChevronDown size={16} aria-hidden />
            ) : (
              <ChevronRight size={16} aria-hidden />
            )}
          </button>
        </td>
        <td className="px-4 py-2 font-mono text-mono tabular-nums">
          {row.inventoryId}
        </td>
        <td className="px-4 py-2 text-foreground">{row.customerName}</td>
        <td className="px-4 py-2 font-mono text-mono tabular-nums">
          {row.billingAccountId}
        </td>
        <td className="px-4 py-2">
          <div className="flex flex-col gap-1">
            <span className="text-foreground">
              {row.offeringName}{" "}
              <span className="font-mono text-mono text-muted-foreground">
                (v{row.offeringVersion})
              </span>
            </span>
            {row.hasOverride && (
              <span className="inline-flex w-fit items-center gap-1 rounded-full bg-[color:var(--color-accent-50)] px-2 py-0.5 text-[11px] font-semibold tracking-wider text-[color:var(--color-accent-700)] uppercase">
                <Handshake size={12} aria-hidden="true" />
                Negotiated
              </span>
            )}
          </div>
        </td>
        <td className="px-4 py-2 text-right tabular-nums">{row.quantity}</td>
        <td className="px-4 py-2 whitespace-nowrap">{row.startDate}</td>
        <td className="px-4 py-2 whitespace-nowrap">
          {row.endDate ?? <span className="text-muted-foreground">—</span>}
        </td>
        <td className="px-4 py-2">
          <SubscriptionStatusBadge status={row.status} />
        </td>
        <td className="px-4 py-2">
          <RowActions
            row={row}
            canEdit={canEdit}
            isExpanded={isExpanded}
            detail={detail}
            onExpand={onToggle}
          />
        </td>
      </tr>
      {isExpanded && detail && (
        <StatusHistoryRows
          history={detail.history}
          suspensionWindows={detail.suspensionWindows}
          colSpan={TABLE_COLUMN_COUNT}
        />
      )}
    </>
  );
}

// Status-gated per pm32's transition matrix (Suspend on ACTIVE; Resume on
// SUSPENDED; Terminate on ACTIVE/SUSPENDED; Edit characteristics on any
// non-TERMINATED); TERMINATED rows show no actions (catalog RETIRED-row
// convention). READ-only viewers (`!canEdit`) see no action buttons at all.
function RowActions({
  row,
  canEdit,
  isExpanded,
  detail,
  onExpand,
}: {
  row: SubscriptionListRow;
  canEdit: boolean;
  isExpanded: boolean;
  detail: SubscriptionDetail | null;
  onExpand: () => void;
}): React.JSX.Element {
  if (row.status === "TERMINATED") {
    return (
      <span className="text-caption text-[color:var(--text-muted)]">
        No actions — terminated
      </span>
    );
  }

  if (!canEdit) {
    return <></>;
  }

  return (
    <div className="flex items-center gap-1.5">
      {row.status === "ACTIVE" && (
        <SuspendDialog
          inventoryId={row.inventoryId}
          trigger={
            <button
              type="button"
              aria-label={`Suspend ${row.inventoryId}`}
              className={cn(ACTION_BUTTON_CLASS, "text-muted-foreground")}
            >
              <PauseCircle size={14} aria-hidden />
            </button>
          }
        />
      )}
      {row.status === "SUSPENDED" && (
        <ResumeDialog
          inventoryId={row.inventoryId}
          trigger={
            <button
              type="button"
              aria-label={`Resume ${row.inventoryId}`}
              className={cn(ACTION_BUTTON_CLASS, "text-muted-foreground")}
            >
              <PlayCircle size={14} aria-hidden />
            </button>
          }
        />
      )}
      <TerminateDialog
        inventoryId={row.inventoryId}
        trigger={
          <button
            type="button"
            aria-label={`Terminate ${row.inventoryId}`}
            className={cn(ACTION_BUTTON_CLASS, "text-destructive")}
          >
            <XCircle size={14} aria-hidden />
          </button>
        }
      />
      {isExpanded && detail ? (
        <EditCharacteristicsDialog
          inventoryId={row.inventoryId}
          characteristics={detail.instanceCharacteristics}
          trigger={
            <button
              type="button"
              aria-label={`Edit characteristics for ${row.inventoryId}`}
              className={cn(ACTION_BUTTON_CLASS, "text-muted-foreground")}
            >
              <Pencil size={14} aria-hidden />
            </button>
          }
        />
      ) : (
        // The row's current characteristics only exist client-side once it's
        // expanded (getSubscriptionDetail is fetched server-side for the
        // `?subscription=`-selected row only, orders-page precedent) — a
        // collapsed row's Edit button expands it first, loading the real
        // values, rather than opening a dialog that could silently blank
        // them out on save.
        <button
          type="button"
          aria-label={`Expand ${row.inventoryId} to edit characteristics`}
          title="Expand this row to edit its characteristics"
          onClick={onExpand}
          className={cn(ACTION_BUTTON_CLASS, "text-muted-foreground")}
        >
          <Pencil size={14} aria-hidden />
        </button>
      )}
    </div>
  );
}

function Header({ label }: { label: string }): React.JSX.Element {
  return (
    <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
      {label}
    </th>
  );
}

function SortableHeader({
  column,
  label,
  activeColumn,
  activeDir,
  isPending,
  onSort,
}: {
  column: SortColumn;
  label: string;
  activeColumn: string;
  activeDir: "asc" | "desc";
  isPending: boolean;
  onSort: (column: SortColumn) => void;
}): React.JSX.Element {
  const isActive = column === activeColumn;
  return (
    <th
      className="px-4 py-3 text-left"
      aria-sort={
        isActive ? (activeDir === "asc" ? "ascending" : "descending") : "none"
      }
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        disabled={isPending}
        className="inline-flex items-center gap-1 text-overline font-semibold tracking-wider text-muted-foreground uppercase"
      >
        {label}
        {isActive &&
          (activeDir === "asc" ? (
            <ChevronUp size={12} />
          ) : (
            <ChevronDown size={12} />
          ))}
      </button>
    </th>
  );
}
