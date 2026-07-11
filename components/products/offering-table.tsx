"use client";

import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  PackageSearch,
  ShoppingCart,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

import { LifecycleBadge } from "@/components/products/lifecycle-badge";
import { Button } from "@/components/ui/button";
import { formatDatetime } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import { LIFECYCLE_STATUSES, type LifecycleStatus } from "@/types/product";
import type { OfferingListRow } from "@/types/product";
import type { OFFERING_SORT_VALUES } from "@/validation/product/offering-list.schema";

type OfferingSort = (typeof OFFERING_SORT_VALUES)[number];
type SortColumn =
  | "name"
  | "product_offering_id"
  | "lifecycle_status"
  | "version"
  | "last_modified";

interface OfferingTableProps {
  rows: OfferingListRow[];
  total: number;
  page: number;
  pageSize: number;
  selectedOfferingId: string | null;
  query: string;
  status: LifecycleStatus | null;
  sort: OfferingSort;
  locale: string;
  timezone: string;
}

const SORTABLE_COLUMNS: Array<{ column: SortColumn; label: string }> = [
  { column: "product_offering_id", label: "ID" },
  { column: "name", label: "Name" },
  { column: "lifecycle_status", label: "Lifecycle" },
  { column: "version", label: "Version" },
  { column: "last_modified", label: "Last Modified" },
];

function parseSort(sort: OfferingSort): {
  column: string;
  dir: "asc" | "desc";
} {
  if (sort.startsWith("-")) {
    return { column: sort.slice(1), dir: "desc" };
  }
  return { column: sort, dir: "asc" };
}

export function OfferingTable({
  rows,
  total,
  page,
  pageSize,
  selectedOfferingId,
  query,
  status,
  sort,
  locale,
  timezone,
}: OfferingTableProps): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [searchInput, setSearchInput] = useState(query);
  // Mirrors `query` into state during render (React's documented pattern for
  // adjusting state when a prop changes, cheaper than an effect) so the box
  // doesn't show stale text when `query` changes from outside this
  // component's own navigate() calls — e.g. browser back/forward, or a deep
  // link with a different `q`.
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

  function applyStatus(next: LifecycleStatus | ""): void {
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

  function selectRow(offeringId: string): void {
    navigate((params) => {
      params.set("offering", offeringId);
    }, true);
  }

  return (
    <div className="rounded-md bg-card shadow-sm">
      <div className="flex flex-wrap items-end gap-3 border-b border-border p-4">
        <div className="flex flex-col gap-1">
          <label className="sr-only" htmlFor="offering-search">
            Search offerings by name
          </label>
          <input
            id="offering-search"
            aria-label="Search offerings by name"
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
          <Button variant="outline" onClick={clearSearch} disabled={isPending}>
            Clear
          </Button>
        )}

        <div className="flex flex-col gap-1">
          <label className="sr-only" htmlFor="offering-status-filter">
            Filter by lifecycle status
          </label>
          <select
            id="offering-status-filter"
            aria-label="Filter by lifecycle status"
            value={status ?? ""}
            onChange={(e) =>
              applyStatus(e.target.value as LifecycleStatus | "")
            }
            disabled={isPending}
            className="h-9 w-40 rounded-sm border border-border bg-card px-3 text-body text-foreground focus:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
          >
            <option value="">All (non-retired)</option>
            {LIFECYCLE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.charAt(0) + s.slice(1).toLowerCase()}
              </option>
            ))}
          </select>
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
              {SORTABLE_COLUMNS.map(({ column, label }) => {
                const isActive = column === activeColumn;
                return (
                  <th
                    key={column}
                    className="px-4 py-3 text-left"
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
              <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                Sellable
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="bg-[color:var(--surface-sunken)] py-16 text-center"
                >
                  <PackageSearch className="mx-auto mb-3 size-12 text-[color:var(--text-muted)]" />
                  <p className="text-body text-muted-foreground">
                    No offerings match your filters
                  </p>
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const isSelected = row.productOfferingId === selectedOfferingId;
                const isRetired = row.lifecycleStatus === "RETIRED";
                const showNotSellable =
                  !row.isSellable && row.lifecycleStatus === "ACTIVE";

                return (
                  <tr
                    key={row.productOfferingId}
                    onClick={() => selectRow(row.productOfferingId)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        selectRow(row.productOfferingId);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                    aria-current={isSelected ? "true" : undefined}
                    className={cn(
                      "cursor-pointer border-b border-[color:var(--border-subtle)] outline-none last:border-0 hover:bg-[color:var(--action-ghost-hover)] focus-visible:[box-shadow:var(--focus-ring)]",
                      isSelected && "bg-[color:var(--surface-selected)]",
                      isRetired && "text-[color:var(--text-muted)]",
                    )}
                  >
                    <td className="px-4 py-2 font-mono text-mono tabular-nums">
                      {row.productOfferingId}
                    </td>
                    <td className="px-4 py-2 text-foreground">{row.name}</td>
                    <td className="px-4 py-2">
                      <LifecycleBadge status={row.lifecycleStatus} />
                    </td>
                    <td className="px-4 py-2 font-mono text-mono tabular-nums">
                      {row.version}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {formatDatetime(row.lastModified, locale, timezone)}
                    </td>
                    <td className="px-4 py-2">
                      {row.isSellable ? (
                        <span className="inline-flex items-center gap-1 rounded-[var(--radius-xs)] bg-[color:var(--color-neutral-100)] px-1.5 py-0.5 text-[11px] font-semibold tracking-wider text-[color:var(--color-neutral-700)] uppercase">
                          <ShoppingCart size={12} aria-hidden="true" />
                          Sellable
                        </span>
                      ) : showNotSellable ? (
                        <span className="inline-flex items-center gap-1 rounded-[var(--radius-xs)] bg-[color:var(--color-warning-50)] px-1.5 py-0.5 text-[11px] font-semibold tracking-wider text-[color:var(--color-warning-700)] uppercase">
                          <ShoppingCart size={12} aria-hidden="true" />
                          Not sellable
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {total > 0 && (
        <div className="flex items-center justify-between border-t border-[color:var(--border-subtle)] px-4 py-4">
          <span className="text-body text-muted-foreground">
            Showing {(page - 1) * pageSize + 1}–
            {Math.min(page * pageSize, total)} of {total} offerings
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
