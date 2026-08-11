"use client";

import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ClipboardList,
  Handshake,
  Plus,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

import { OrderStatusBadge } from "@/components/products/ordering/order-status-badge";
import { Button } from "@/components/ui/button";
import { formatDatetime } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import {
  ORDER_STATUSES,
  type OrderListRow,
  type OrderStatus,
} from "@/types/ordering";
import type { ORDER_SORT_VALUES } from "@/validation/ordering/orders-list.schema";

type OrderSort = (typeof ORDER_SORT_VALUES)[number];
type SortColumn = "product_order_id" | "status" | "submitted_at";

interface OrdersTableProps {
  rows: OrderListRow[];
  total: number;
  page: number;
  pageSize: number;
  selectedOrderId: string | null;
  query: string;
  status: OrderStatus | null;
  sort: OrderSort;
  locale: string;
  timezone: string;
}

function statusLabel(status: OrderStatus): string {
  return status
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function parseSort(sort: OrderSort): { column: string; dir: "asc" | "desc" } {
  if (sort.startsWith("-")) {
    return { column: sort.slice(1), dir: "desc" };
  }
  return { column: sort, dir: "asc" };
}

export function OrdersTable({
  rows,
  total,
  page,
  pageSize,
  selectedOrderId,
  query,
  status,
  sort,
  locale,
  timezone,
}: OrdersTableProps): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [searchInput, setSearchInput] = useState(query);
  // Render-time prop sync (offering-table precedent) — avoids the
  // `react-hooks/set-state-in-effect` lint rule an effect-based sync trips.
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

  function applyStatus(next: OrderStatus | ""): void {
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

  function selectRow(orderId: string): void {
    navigate((params) => {
      params.set("order", orderId);
    }, true);
  }

  return (
    <div className="rounded-md bg-card shadow-sm">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="sr-only" htmlFor="order-search">
              Search orders by customer or order ID
            </label>
            <input
              id="order-search"
              aria-label="Search orders by customer or order ID"
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
            <label className="sr-only" htmlFor="order-status-filter">
              Filter by order status
            </label>
            <select
              id="order-status-filter"
              aria-label="Filter by order status"
              value={status ?? ""}
              onChange={(e) => applyStatus(e.target.value as OrderStatus | "")}
              disabled={isPending}
              className="h-9 w-44 rounded-sm border border-border bg-card px-3 text-body text-foreground focus:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
            >
              <option value="">All statuses</option>
              {ORDER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {statusLabel(s)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* pm29 seam: New order opens the 3-step wizard. No handler yet —
            renders fully wired-looking, does nothing on click. */}
        <button
          type="button"
          aria-label="New order"
          className="inline-flex items-center gap-1.5 rounded-md bg-[color:var(--action-cta-bg)] px-3 py-2 text-body-sm font-semibold text-white"
        >
          <Plus size={16} aria-hidden />
          New order
        </button>
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
              <SortableHeader
                column="product_order_id"
                label="Order ID"
                activeColumn={activeColumn}
                activeDir={activeDir}
                isPending={isPending}
                onSort={applySort}
              />
              <Header label="Customer" />
              <Header label="BAN" />
              <Header label="Offer" />
              <Header label="Qty" />
              <Header label="Start" />
              <Header label="Price" />
              <SortableHeader
                column="status"
                label="Status"
                activeColumn={activeColumn}
                activeDir={activeDir}
                isPending={isPending}
                onSort={applySort}
              />
              <SortableHeader
                column="submitted_at"
                label="Submitted"
                activeColumn={activeColumn}
                activeDir={activeDir}
                isPending={isPending}
                onSort={applySort}
              />
              <Header label="Reviewed" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={10}
                  className="bg-[color:var(--surface-sunken)] py-16 text-center"
                >
                  <ClipboardList className="mx-auto mb-3 size-12 text-[color:var(--text-muted)]" />
                  <p className="text-body text-muted-foreground">
                    No orders match your filters
                  </p>
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const isSelected = row.orderId === selectedOrderId;

                return (
                  <tr
                    key={row.orderId}
                    onClick={() => selectRow(row.orderId)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        selectRow(row.orderId);
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
                    <td className="px-4 py-2 font-mono text-mono tabular-nums">
                      {row.orderId}
                    </td>
                    <td className="px-4 py-2 text-foreground">
                      {row.customerName}
                    </td>
                    <td className="px-4 py-2 font-mono text-mono tabular-nums">
                      {row.billingAccountId}
                    </td>
                    <td className="px-4 py-2 text-foreground">
                      {row.offeringName}{" "}
                      <span className="font-mono text-mono text-muted-foreground">
                        (v{row.offeringVersion})
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {row.quantity}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {row.startDate}
                    </td>
                    <td className="px-4 py-2">
                      {row.hasOverride ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-[color:var(--color-accent-50)] px-2 py-0.5 text-[11px] font-semibold tracking-wider text-[color:var(--color-accent-700)] uppercase">
                          <Handshake size={12} aria-hidden="true" />
                          Negotiated
                        </span>
                      ) : (
                        <span className="text-muted-foreground">list</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <OrderStatusBadge status={row.status} />
                        {row.status === "PENDING" && (
                          // pm31 seam: opens the manager review screen. No
                          // handler yet — renders fully wired-looking, does
                          // nothing on click.
                          <button
                            type="button"
                            aria-label={`Review order ${row.orderId}`}
                            onClick={(e) => e.stopPropagation()}
                            className="rounded-sm border-[0.5px] border-[color:var(--border)] px-1.5 py-0.5 text-caption text-muted-foreground"
                          >
                            Review
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {row.submittedByName} ·{" "}
                      {formatDatetime(row.submittedAt, locale, timezone)}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {row.reviewedByName !== null ? (
                        <>
                          {row.reviewedByName} ·{" "}
                          {formatDatetime(row.reviewedAt, locale, timezone)}
                        </>
                      ) : !row.hasOverride && row.status === "COMPLETED" ? (
                        <span className="text-muted-foreground">— (auto)</span>
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
            {Math.min(page * pageSize, total)} of {total} orders
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
