"use client";

// Transfers grid (ac06-spec §2.2, code-standards §4.3). Dense (`text-sm`,
// sticky header), server-paginated, sort is a URL param (matches the
// Product/Customer search-grid pattern — `offering-table.tsx`). Amounts here
// are unsigned transfer amounts — direction is conveyed by the from/to
// columns, not sign (the signed convention is taught in the drawer).

import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Waypoints,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

import { AmountCell } from "@/components/accounts/amount-cell";
import { LedgerKindChip } from "@/components/accounts/ledger-kind-chip";
import { formatDatetime } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type { LedgerTransferListItem } from "@/types/accounts";
import type { LedgerTransferSort } from "@/validation/accounts/ledger-explorer-search-params.schema";

type SortColumn = "event_at" | "created_at" | "amount";

const SORTABLE_COLUMNS: Array<{ column: SortColumn; label: string }> = [
  { column: "event_at", label: "Event At" },
  { column: "created_at", label: "Created At" },
  { column: "amount", label: "Amount" },
];

function parseSort(sort: LedgerTransferSort): {
  column: string;
  dir: "asc" | "desc";
} {
  if (sort.startsWith("-")) {
    return { column: sort.slice(1), dir: "desc" };
  }
  return { column: sort, dir: "asc" };
}

export interface LedgerTransfersGridProps {
  accountId: string;
  currency: string;
  rows: LedgerTransferListItem[];
  total: number;
  page: number;
  pageSize: number;
  sort: LedgerTransferSort;
  from: string | null;
  to: string | null;
  q: string;
  selectedTransferId: string | null;
  locale: string;
  timezone: string;
}

export function LedgerTransfersGrid({
  accountId,
  currency,
  rows,
  total,
  page,
  pageSize,
  sort,
  from,
  to,
  q,
  selectedTransferId,
  locale,
  timezone,
}: LedgerTransfersGridProps): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const [fromInput, setFromInput] = useState(from ?? "");
  const [toInput, setToInput] = useState(to ?? "");
  const [qInput, setQInput] = useState(q);

  const { column: activeColumn, dir: activeDir } = parseSort(sort);
  const totalPages = Math.ceil(total / pageSize);

  function navigate(mutate: (params: URLSearchParams) => void, push = false) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("account", accountId);
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

  function applyFilters(): void {
    navigate((params) => {
      if (fromInput) {
        params.set("from", fromInput);
      } else {
        params.delete("from");
      }
      if (toInput) {
        params.set("to", toInput);
      } else {
        params.delete("to");
      }
      if (qInput) {
        params.set("q", qInput);
      } else {
        params.delete("q");
      }
      params.set("page", "1");
    });
  }

  function applySort(column: SortColumn): void {
    const nextSort: LedgerTransferSort =
      column === activeColumn && activeDir === "asc"
        ? (`-${column}` as LedgerTransferSort)
        : column;
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

  function selectTransfer(transferId: string): void {
    navigate((params) => {
      params.set("transfer", transferId);
    }, true);
  }

  return (
    <div className="rounded-none border border-border bg-card">
      <div className="flex flex-wrap items-end gap-3 border-b border-border p-4">
        <div className="flex flex-col gap-1">
          <label
            htmlFor="ledger-from"
            className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
          >
            Event from
          </label>
          <input
            id="ledger-from"
            type="date"
            value={fromInput}
            onChange={(e) => setFromInput(e.target.value)}
            disabled={isPending}
            className="h-9 rounded-sm border border-border bg-card px-2 text-body text-foreground focus:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label
            htmlFor="ledger-to"
            className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
          >
            Event to
          </label>
          <input
            id="ledger-to"
            type="date"
            value={toInput}
            onChange={(e) => setToInput(e.target.value)}
            disabled={isPending}
            className="h-9 rounded-sm border border-border bg-card px-2 text-body text-foreground focus:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
          />
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <label
            htmlFor="ledger-meta-q"
            className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
          >
            Metadata search (doc / ban / type)
          </label>
          <input
            id="ledger-meta-q"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyFilters();
            }}
            disabled={isPending}
            className="h-9 min-w-[16rem] rounded-sm border border-border bg-card px-3 text-body text-foreground focus:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
          />
        </div>
        <button
          type="button"
          onClick={applyFilters}
          disabled={isPending}
          className="h-9 rounded-md bg-[color:var(--action-primary-bg)] px-4 text-body font-medium text-white hover:bg-[color:var(--action-primary-bg-hover)]"
        >
          Apply
        </button>
      </div>

      <div
        className={cn(
          "overflow-x-auto",
          isPending && "opacity-60 transition-opacity",
        )}
      >
        <table className="w-full border-collapse text-body-sm">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-border bg-[color:var(--surface-sunken)]">
              <th className="px-4 py-2 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                From
              </th>
              <th className="px-4 py-2 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                To
              </th>
              {SORTABLE_COLUMNS.map(({ column, label }) => {
                const isActive = column === activeColumn;
                return (
                  <th
                    key={column}
                    className={cn(
                      "px-4 py-2",
                      column === "amount" ? "text-right" : "text-left",
                    )}
                    aria-sort={
                      isActive
                        ? activeDir === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    <button
                      type="button"
                      onClick={() => applySort(column)}
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
              })}
              <th className="px-4 py-2 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                Doc
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-16 text-center">
                  <Waypoints className="mx-auto mb-3 size-12 text-[color:var(--text-disabled)]" />
                  <p className="text-body text-muted-foreground">
                    No transfers match your filters
                  </p>
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const isSelected = row.id === selectedTransferId;
                return (
                  <tr
                    key={row.id}
                    onClick={() => selectTransfer(row.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        selectTransfer(row.id);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                    aria-current={isSelected ? "true" : undefined}
                    className={cn(
                      "cursor-pointer border-b border-[color:var(--border-subtle)] outline-none last:border-0 hover:bg-[color:var(--action-ghost-hover)] focus-visible:[box-shadow:var(--focus-ring)]",
                      isSelected && "bg-[color:var(--surface-selected)]",
                    )}
                  >
                    <td className="px-4 py-2">
                      <span className="flex items-center gap-2">
                        <LedgerKindChip kind={row.fromLabel.kind} />
                        <span className="truncate font-mono text-mono">
                          {row.fromLabel.ownerLabel ?? row.fromAccountName}
                        </span>
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <span className="flex items-center gap-2">
                        <LedgerKindChip kind={row.toLabel.kind} />
                        <span className="truncate font-mono text-mono">
                          {row.toLabel.ownerLabel ?? row.toAccountName}
                        </span>
                      </span>
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {formatDatetime(row.eventAt, locale, timezone)}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {formatDatetime(row.createdAt, locale, timezone)}
                    </td>
                    <td className="px-4 py-2">
                      <AmountCell amount={row.amount} currency={currency} />
                    </td>
                    <td
                      className="max-w-[160px] truncate px-4 py-2 font-mono text-mono text-muted-foreground"
                      title={row.metadataDoc ?? undefined}
                    >
                      {row.metadataDoc ?? "—"}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {total > 0 && (
        <div className="flex items-center justify-between border-t border-[color:var(--border-subtle)] px-4 py-3">
          <span className="text-body-sm text-muted-foreground">
            Showing {(page - 1) * pageSize + 1}–
            {Math.min(page * pageSize, total)} of {total} transfers
          </span>
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
            <span className="px-2 text-body-sm text-muted-foreground">
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
