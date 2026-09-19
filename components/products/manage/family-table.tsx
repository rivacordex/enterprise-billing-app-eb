import Link from "next/link";
import { PackageSearch } from "lucide-react";

import {
  BillingOnlyChip,
  SellabilityChip,
} from "@/components/products/flag-chips";
import {
  LIFECYCLE_BADGE_VARIANTS,
  LifecycleBadge,
} from "@/components/products/lifecycle-badge";
import {
  MANAGE_PRODUCTS_PATH,
  buildManageProductsHref,
} from "@/components/products/manage/manage-products-href";
import { ListPagination } from "@/components/products/list-pagination";
import { formatDatetime } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import {
  LIFECYCLE_STATUSES,
  type FamilyPage,
  type LifecycleStatus,
} from "@/types/product";

export interface FamilyTableProps {
  page: FamilyPage;
  query: string;
  status: LifecycleStatus | null;
  locale: string;
  timezone: string;
}

// Server component (code-standards §3.6): rows and pagination are `<Link>`s
// (§3.4 — no client selection state) and the search/filter is a GET `<form>`
// that rewrites the URL on submit without any client JS, so the whole table
// renders on the server. Row/pagination/clear links share `buildManageProductsHref`
// with the version bar so the two never drift (pm40 review dedup). pm40 layers
// the version bar and panels on top of the same `?family=` selection this table
// writes.

export function FamilyTable({
  page,
  query,
  status,
  locale,
  timezone,
}: FamilyTableProps): React.JSX.Element {
  const { rows, total, page: currentPage, pageSize } = page;
  const totalPages = Math.ceil(total / pageSize) || 1;
  const hasFilters = query !== "" || status !== null;

  return (
    <div className="rounded-md bg-card shadow-sm">
      {/* Search + status filter: a GET form so the URL is rewritten on submit
          with no client component (the empty option maps to "all statuses"). */}
      <form
        action={MANAGE_PRODUCTS_PATH}
        method="get"
        className="flex flex-wrap items-end gap-3 border-b border-border p-4"
      >
        <div className="flex flex-col gap-1">
          <label className="sr-only" htmlFor="family-search">
            Search products by name
          </label>
          <input
            id="family-search"
            name="q"
            defaultValue={query}
            aria-label="Search products by name"
            className="h-9 w-56 rounded-sm border border-border bg-card px-3 text-body text-foreground focus:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="sr-only" htmlFor="family-status-filter">
            Filter by lifecycle status
          </label>
          <select
            id="family-status-filter"
            name="status"
            defaultValue={status ?? ""}
            aria-label="Filter by lifecycle status"
            className="h-9 w-40 rounded-sm border border-border bg-card px-3 text-body text-foreground focus:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
          >
            <option value="">All statuses</option>
            {LIFECYCLE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {LIFECYCLE_BADGE_VARIANTS[s].label}
              </option>
            ))}
          </select>
        </div>

        <button
          type="submit"
          className="inline-flex h-9 items-center rounded-md border border-[color:var(--action-secondary-border)] bg-[color:var(--action-secondary-bg)] px-3 text-body-sm font-semibold text-[color:var(--action-secondary-text)] hover:bg-[color:var(--action-ghost-hover)]"
        >
          Apply
        </button>
        {hasFilters && (
          <Link
            href={MANAGE_PRODUCTS_PATH}
            className="inline-flex h-9 items-center rounded-md border border-border px-3 text-body-sm font-semibold text-muted-foreground hover:text-foreground"
          >
            Clear
          </Link>
        )}
      </form>

      {rows.length === 0 ? (
        total === 0 ? (
          hasFilters ? (
            // No search/filter match — names the query, offers to clear.
            <div className="flex flex-col items-center gap-3 bg-[color:var(--surface-sunken)] py-16 text-center">
              <PackageSearch className="size-12 text-[color:var(--text-muted)]" />
              <p className="text-body text-muted-foreground">
                No products match
                {query !== "" ? ` “${query}”` : ""}
                {status !== null
                  ? ` with status ${LIFECYCLE_BADGE_VARIANTS[status].label}`
                  : ""}
                .
              </p>
              <Link
                href={MANAGE_PRODUCTS_PATH}
                className="text-body-sm font-semibold text-[color:var(--text-link)] hover:underline"
              >
                Clear filters
              </Link>
            </div>
          ) : (
            // Fresh catalog — points at the header CTA rather than repeating it.
            <div className="flex flex-col items-center gap-2 bg-[color:var(--surface-sunken)] py-16 text-center">
              <PackageSearch className="size-12 text-[color:var(--text-muted)]" />
              <p className="text-body text-muted-foreground">
                No products yet. Create the first offering to start the catalog.
              </p>
              <p className="text-caption text-[color:var(--text-muted)]">
                Use “New offering” above to begin.
              </p>
            </div>
          )
        ) : (
          // Page past the last page (e.g. a stale ?page= deep link): products
          // exist, this page just has none. Point back to page 1 preserving the
          // filters; the pager below is suppressed for this state (rows.length).
          <div className="flex flex-col items-center gap-3 bg-[color:var(--surface-sunken)] py-16 text-center">
            <PackageSearch className="size-12 text-[color:var(--text-muted)]" />
            <p className="text-body text-muted-foreground">
              This page is empty — there {totalPages === 1 ? "is" : "are"} only{" "}
              {totalPages} {totalPages === 1 ? "page" : "pages"} of products.
            </p>
            <Link
              href={buildManageProductsHref({ q: query, status })}
              className="text-body-sm font-semibold text-[color:var(--text-link)] hover:underline"
            >
              Go to the first page
            </Link>
          </div>
        )
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-body">
            <thead>
              <tr className="border-b border-border bg-[color:var(--surface-sunken)]">
                {[
                  "ID",
                  "Name",
                  "Status",
                  "Version",
                  "Versions",
                  "Flags",
                  "Last Modified",
                ].map((label) => (
                  <th
                    key={label}
                    className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase"
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isMuted =
                  LIFECYCLE_BADGE_VARIANTS[row.lifecycleStatus].muted;
                return (
                  <tr
                    key={row.familyId}
                    className={cn(
                      "border-b border-[color:var(--border-subtle)] last:border-0 hover:bg-[color:var(--action-ghost-hover)]",
                      isMuted && "text-[color:var(--text-muted)]",
                    )}
                  >
                    <td className="px-4 py-2 font-mono text-mono tabular-nums">
                      {row.primaryVersionId}
                    </td>
                    <td className="px-4 py-2">
                      <Link
                        href={buildManageProductsHref({
                          q: query,
                          status,
                          page: currentPage,
                          family: row.familyId,
                        })}
                        className={cn(
                          "font-medium hover:underline focus-visible:[box-shadow:var(--focus-ring)] focus-visible:outline-none",
                          !isMuted && "text-foreground",
                        )}
                      >
                        {row.name}
                      </Link>
                    </td>
                    <td className="px-4 py-2">
                      <LifecycleBadge status={row.lifecycleStatus} />
                    </td>
                    <td className="px-4 py-2 font-mono text-mono tabular-nums">
                      {row.version}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground tabular-nums">
                      {row.versionCount}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap items-center gap-1">
                        <SellabilityChip
                          isSellable={row.isSellable}
                          lifecycleStatus={row.lifecycleStatus}
                        />
                        {row.billingOnly && <BillingOnlyChip />}
                      </div>
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {formatDatetime(row.lastModified, locale, timezone)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > 0 && (
        <ListPagination
          page={currentPage}
          pageSize={pageSize}
          total={total}
          itemLabel="products"
          hrefFor={(p) =>
            buildManageProductsHref({ q: query, status, page: p })
          }
        />
      )}
    </div>
  );
}
