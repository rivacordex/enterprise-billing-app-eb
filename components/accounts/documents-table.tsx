"use client";

// ac20-spec §2.4/§3.5 — dense, server-paginated documents table for the
// Transactions workbench. Follows ledger-transfers-grid.tsx in shape: sort is
// a URL param (matches what's on screen), filter state lives in the URL only
// (inv. #17), amounts via AmountCell, dates via formatDatetime.
// `"use client"` is required for useSearchParams() (URL navigation) and the
// inline approve stopgap (ac21 will move the approve action to the drawer).

import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FileText,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

import { AmountCell } from "@/components/accounts/amount-cell";
import { DocStateBadge } from "@/components/accounts/doc-state-badge";
import { ReverseButton } from "@/components/accounts/reversal-dialog";
import { formatDatetime } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type {
  DocState,
  DocType,
  TransactionDocumentRow,
} from "@/types/accounts";
import { DOC_STATES, DOC_TYPES } from "@/types/accounts";
import type { TransactionDocumentSort } from "@/validation/accounts/transactions-search-params.schema";

type SortColumn = "event_at" | "amount";

const SORTABLE_COLUMNS: Array<{ column: SortColumn; label: string }> = [
  { column: "event_at", label: "Date" },
  { column: "amount", label: "Amount" },
];

function parseSort(sort: TransactionDocumentSort): {
  column: string;
  dir: "asc" | "desc";
} {
  if (sort.startsWith("-")) return { column: sort.slice(1), dir: "desc" };
  return { column: sort, dir: "asc" };
}

const DOC_TYPE_LABELS: Record<DocType, string> = {
  PAY: "PAY",
  DEP: "DEP",
  CRN: "CRN",
  DBN: "DBN",
  ADJ: "ADJ",
  INV: "INV",
};

const DOC_STATE_LABELS: Record<DocState, string> = {
  draft: "Draft",
  pending_approval: "Pending approval",
  posted: "Posted",
  reversed: "Reversed",
  cancelled: "Cancelled",
};

// Scope-marker chip — reuses the account-kind CSS tokens (ui-context §1.2).
function ScopeMarker({
  refBillingAccountId,
}: {
  refBillingAccountId: string | null;
}): React.JSX.Element {
  if (refBillingAccountId === null) {
    return (
      <span className="inline-flex items-center rounded-full bg-[color:var(--acct-chip-fa-bg)] px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-[color:var(--acct-chip-fa-fg)] uppercase">
        FA-level
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-[color:var(--acct-chip-ban-bg)] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[color:var(--acct-chip-ban-fg)]">
      {refBillingAccountId}
    </span>
  );
}

// DocType chip — neutral chip identifying the document type.
function DocTypeChip({ docType }: { docType: DocType }): React.JSX.Element {
  return (
    <span className="inline-flex items-center rounded-full bg-[color:var(--color-neutral-100)] px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wider text-[color:var(--color-neutral-600)] uppercase">
      {DOC_TYPE_LABELS[docType]}
    </span>
  );
}

export interface DocumentsTableProps {
  rows: TransactionDocumentRow[];
  total: number;
  page: number;
  pageSize: number;
  sort: TransactionDocumentSort;
  type: DocType | null;
  status: DocState | null;
  rev: "reversible" | "partial" | null;
  q: string;
  locale: string;
  timezone: string;
  // Link for the "no FA" empty state — Overview with context params preserved.
  overviewHref: string;
  // Passed so the component can distinguish "no context" vs "FA present, no results".
  financialAccountId: string | undefined;
  // ac22-spec §3.2 — the ↺ Reverse row action renders only for EDIT holders on
  // eligible rows. READ-only holders see no reversal control (D5/§2.8).
  canEdit: boolean;
}

export function DocumentsTable({
  rows,
  total,
  page,
  pageSize,
  sort,
  type,
  status,
  rev,
  q,
  locale,
  timezone,
  overviewHref,
  financialAccountId,
  canEdit,
}: DocumentsTableProps): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const [qInput, setQInput] = useState(q);
  const { column: activeColumn, dir: activeDir } = parseSort(sort);
  const totalPages = Math.ceil(total / pageSize);

  function navigate(
    mutate: (params: URLSearchParams) => void,
    push = false,
  ): void {
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

  function applyFilters(): void {
    navigate((params) => {
      if (qInput) {
        params.set("q", qInput);
      } else {
        params.delete("q");
      }
      params.set("page", "1");
    });
  }

  function setFilter(key: string, value: string | null): void {
    navigate((params) => {
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
      params.set("page", "1");
    });
  }

  function applySort(column: SortColumn): void {
    const nextSort: TransactionDocumentSort =
      column === activeColumn && activeDir === "asc"
        ? (`-${column}` as TransactionDocumentSort)
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

  function openDoc(documentId: string): void {
    navigate((params) => {
      params.set("doc", documentId);
    }, true);
  }

  // No FA selected — context-selection empty state.
  if (!financialAccountId) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <FileText className="size-12 text-[color:var(--text-disabled)]" />
        <p className="text-body text-muted-foreground">
          Select a Financial Account in{" "}
          <a
            href={overviewHref}
            className="font-medium text-foreground underline underline-offset-2 hover:no-underline"
          >
            Accounts Overview
          </a>{" "}
          to view documents.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-none border border-border bg-card">
      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-3 border-b border-border p-4">
        {/* Type */}
        <div className="flex flex-col gap-1">
          <label
            htmlFor="doc-type-filter"
            className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
          >
            Type
          </label>
          <select
            id="doc-type-filter"
            value={type ?? ""}
            onChange={(e) => setFilter("type", e.target.value || null)}
            disabled={isPending}
            className="h-9 rounded-sm border border-border bg-card px-2 text-body text-foreground focus:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
          >
            <option value="">All types</option>
            {DOC_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        {/* Status */}
        <div className="flex flex-col gap-1">
          <label
            htmlFor="doc-status-filter"
            className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
          >
            Status
          </label>
          <select
            id="doc-status-filter"
            value={status ?? ""}
            onChange={(e) => setFilter("status", e.target.value || null)}
            disabled={isPending}
            className="h-9 rounded-sm border border-border bg-card px-2 text-body text-foreground focus:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
          >
            <option value="">All statuses</option>
            {DOC_STATES.map((s) => (
              <option key={s} value={s}>
                {DOC_STATE_LABELS[s]}
              </option>
            ))}
          </select>
        </div>

        {/* Reversibility */}
        <div className="flex flex-col gap-1">
          <label
            htmlFor="doc-rev-filter"
            className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
          >
            Reversibility
          </label>
          <select
            id="doc-rev-filter"
            value={rev ?? ""}
            onChange={(e) => setFilter("rev", e.target.value || null)}
            disabled={isPending}
            className="h-9 rounded-sm border border-border bg-card px-2 text-body text-foreground focus:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
          >
            <option value="">All</option>
            <option value="reversible">Reversible</option>
            <option value="partial">Partially reversed</option>
          </select>
        </div>

        {/* Text search */}
        <div className="flex flex-1 flex-col gap-1">
          <label
            htmlFor="doc-q-filter"
            className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
          >
            Search (doc ID / reason)
          </label>
          <input
            id="doc-q-filter"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyFilters();
            }}
            disabled={isPending}
            placeholder="PAY00000001 or reason code…"
            className="h-9 min-w-[16rem] rounded-sm border border-border bg-card px-3 text-body text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
          />
        </div>

        <button
          type="button"
          onClick={applyFilters}
          disabled={isPending}
          className="h-9 rounded-md bg-[color:var(--action-primary-bg)] px-4 text-body font-medium text-white hover:bg-[color:var(--action-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Apply
        </button>
      </div>

      {/* Table */}
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
                Doc
              </th>
              <th className="px-4 py-2 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                Type / Action
              </th>
              <th className="px-4 py-2 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                Reason
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
                Status
              </th>
              <th className="px-4 py-2 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                By
              </th>
              <th className="px-4 py-2 text-right text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-16 text-center">
                  <FileText className="mx-auto mb-3 size-12 text-[color:var(--text-disabled)]" />
                  <p className="text-body text-muted-foreground">
                    No documents match your filters
                  </p>
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.documentId}
                  onClick={() => openDoc(row.documentId)}
                  className="cursor-pointer border-b border-[color:var(--border-subtle)] last:border-0 hover:bg-[color:var(--action-ghost-hover)]"
                >
                  {/* Doc ID — button provides keyboard + a11y; tr onClick is
                      mouse-only convenience for the rest of the row cells. */}
                  <td className="px-4 py-2">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openDoc(row.documentId);
                      }}
                      aria-label={`Open document ${row.documentId}`}
                      className="font-mono text-mono text-muted-foreground hover:underline focus-visible:[box-shadow:var(--focus-ring)] focus-visible:outline-none"
                    >
                      {row.documentId}
                    </button>
                  </td>
                  {/* Type / Action / Scope marker */}
                  <td className="px-4 py-2">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <DocTypeChip docType={row.docType} />
                      <span className="text-foreground">{row.actionLabel}</span>
                      <ScopeMarker
                        refBillingAccountId={row.refBillingAccountId}
                      />
                    </span>
                  </td>
                  {/* Reason code */}
                  <td className="px-4 py-2 text-muted-foreground">
                    {row.reasonCode}
                  </td>
                  {/* Date (sortable) */}
                  <td className="px-4 py-2 whitespace-nowrap">
                    {formatDatetime(row.eventAt, locale, timezone)}
                  </td>
                  {/* Amount (sortable, right-aligned) */}
                  <td className="px-4 py-2">
                    <AmountCell
                      amount={row.totalAmount}
                      currency={row.currency}
                    />
                  </td>
                  {/* Status + partially-reversed badge */}
                  <td className="px-4 py-2">
                    <DocStateBadge
                      state={row.state}
                      partiallyReversed={row.partiallyReversed}
                    />
                  </td>
                  {/* Created by */}
                  <td className="max-w-[160px] truncate px-4 py-2 font-mono text-mono text-muted-foreground">
                    {row.createdBy}
                  </td>
                  {/* ac22-spec §3.2 — ↺ Reverse on eligible rows only. Hidden
                      (not disabled) elsewhere per D4/§2.2. stopPropagation lives
                      in ReverseButton so the row's drawer link does not fire. */}
                  <td className="px-4 py-2 text-right">
                    {canEdit && row.reversible && (
                      <ReverseButton
                        documentId={row.documentId}
                        financialAccountId={financialAccountId}
                      />
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > 0 && (
        <div className="flex items-center justify-between border-t border-[color:var(--border-subtle)] px-4 py-3">
          {rows.length > 0 ? (
            <span className="text-body-sm text-muted-foreground">
              Showing {(page - 1) * pageSize + 1}–
              {Math.min(page * pageSize, total)} of {total} document
              {total !== 1 ? "s" : ""}
            </span>
          ) : (
            <span className="text-body-sm text-muted-foreground">
              {total} document{total !== 1 ? "s" : ""}
            </span>
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
