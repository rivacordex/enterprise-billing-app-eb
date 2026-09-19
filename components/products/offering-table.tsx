"use client";

import { ChevronDown, ChevronUp, PackageSearch } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

import { SellabilityChip } from "@/components/products/flag-chips";
import {
  LIFECYCLE_BADGE_VARIANTS,
  LifecycleBadge,
} from "@/components/products/lifecycle-badge";
import { ListPagination } from "@/components/products/list-pagination";
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
  // Keeps the search input in sync with the `query` prop across external
  // navigation (back/forward, deep links) via React's render-time
  // prop-sync pattern rather than an effect — `setState` during an effect
  // body causes a cascading extra render and trips the
  // `react-hooks/set-state-in-effect` lint rule.
  const [prevQuery, setPrevQuery] = useState(query);
  if (query !== prevQuery) {
    setPrevQuery(query);
    setSearchInput(query);
  }

  const { column: activeColumn, dir: activeDir } = parseSort(sort);

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
            <option value="">All (excl. obsolete &amp; retired)</option>
            {LIFECYCLE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {LIFECYCLE_BADGE_VARIANTS[s].label}
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
                // De-emphasise the terminal greys (OBSOLETE + RETIRED) via the
                // badge's own muted flag rather than a hardcoded === 'RETIRED'
                // — that literal now misses OBSOLETE (pm37 D3/G2).
                const isMuted =
                  LIFECYCLE_BADGE_VARIANTS[row.lifecycleStatus].muted;

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
                      isMuted && "text-[color:var(--text-muted)]",
                    )}
                  >
                    <td className="px-4 py-2 font-mono text-mono tabular-nums">
                      {row.productOfferingId}
                    </td>
                    <td
                      className={cn("px-4 py-2", !isMuted && "text-foreground")}
                    >
                      {row.name}
                    </td>
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
                      <SellabilityChip
                        isSellable={row.isSellable}
                        lifecycleStatus={row.lifecycleStatus}
                        emptyFallback={
                          <span className="text-muted-foreground">—</span>
                        }
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {total > 0 && (
        <ListPagination
          page={page}
          pageSize={pageSize}
          total={total}
          itemLabel="offerings"
          onNavigate={goToPage}
          disabled={isPending}
        />
      )}
    </div>
  );
}
