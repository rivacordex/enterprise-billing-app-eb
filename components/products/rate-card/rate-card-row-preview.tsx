import Link from "next/link";
import { Search } from "lucide-react";

import { ListPagination } from "@/components/products/list-pagination";
import {
  RATE_CARD_PATH,
  buildRateCardHref,
} from "@/components/products/rate-card/rate-card-href";
import { formatCalendarDate } from "@/lib/formatters";
import type { RatecardRanUsageLkp } from "@/types/product";

// pm65-spec D9 / I2 / ui-context §10.3/§10.7 — the row preview. SERVER
// component (§3.6), paged and filterable, reusing the Administration table
// primitives + `ListPagination` (§4.3) — NO parallel table implementation and
// no per-row action cluster. 5,400 rows never render at once; the footer states
// `Showing 1–n of N` (ListPagination). The filter is a GET `<form>` that
// rewrites `?q=` with no client JS, exactly like the families table's search.
//
// Dates render ISO through the shared `formatCalendarDate` (D8) — never an
// inline `toISOString()` and never a second date helper. `polygon_start_date`
// and `polygon_end_date` are calendar dates (`string`, YYYY-MM-DD end to end),
// so they never take the timezone prop; getting that backwards moves a polygon
// date by a day at a zone boundary.
//
// `rate_per_unit` renders its value in mono when present and a plain `—` in
// muted when null — the same not-applicable treatment as any other optional
// column (D9/§10.3). It NEVER goes through `formatCurrency`: there is no
// currency column to call it with (§1.45, Inv. #53), and `formatCurrency` is
// called NOWHERE on this page.

export interface RateCardRowPreviewProps {
  versionId: string;
  rows: RatecardRanUsageLkp[];
  total: number;
  page: number;
  pageSize: number;
  query: string;
}

const HEADERS = [
  "MNO",
  "Commercial Unit",
  "Polygon",
  "Polygon start",
  "Polygon end",
  "State",
  "District",
  "Subscriber Ref",
  "Service Code",
  "Rate / unit",
] as const;

function OptionalText({ value }: { value: string | null }): React.JSX.Element {
  if (value === null || value === "") {
    return <span className="text-[color:var(--text-muted)]">—</span>;
  }
  return <>{value}</>;
}

export function RateCardRowPreview({
  versionId,
  rows,
  total,
  page,
  pageSize,
  query,
}: RateCardRowPreviewProps): React.JSX.Element {
  const hasFilter = query !== "";

  return (
    <div className="rounded-md bg-card shadow-sm">
      {/* Filter: a GET form so the URL is rewritten on submit with no client
          component. `version` rides a hidden input so the filter stays scoped
          to the selected version; submitting resets to page 1 (no page field). */}
      <form
        action={RATE_CARD_PATH}
        method="get"
        className="flex flex-wrap items-end gap-3 border-b border-border p-4"
      >
        <input type="hidden" name="version" value={versionId} />
        <div className="flex flex-col gap-1">
          <label className="sr-only" htmlFor="ratecard-row-search">
            Filter rows
          </label>
          <input
            id="ratecard-row-search"
            name="q"
            defaultValue={query}
            placeholder="Filter by MNO, commercial unit, polygon, subscriber…"
            aria-label="Filter rows"
            className="h-9 w-80 rounded-sm border border-border bg-card px-3 text-body text-foreground focus:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
          />
        </div>
        <button
          type="submit"
          className="inline-flex h-9 items-center rounded-md border border-[color:var(--action-secondary-border)] bg-[color:var(--action-secondary-bg)] px-3 text-body-sm font-semibold text-[color:var(--action-secondary-text)] hover:bg-[color:var(--action-ghost-hover)]"
        >
          Apply
        </button>
        {hasFilter && (
          <Link
            href={buildRateCardHref({ version: versionId })}
            className="inline-flex h-9 items-center rounded-md border border-border px-3 text-body-sm font-semibold text-muted-foreground hover:text-foreground"
          >
            Clear filters
          </Link>
        )}
      </form>

      {rows.length === 0 ? (
        hasFilter ? (
          // D10, empty state #2 — "no rows match this filter". Names the query
          // and offers a quiet Clear filters. Reads differently from the
          // version table's "no versions yet" state (§6/§10.7).
          <div className="flex flex-col items-center gap-3 bg-[color:var(--surface-sunken)] py-16 text-center">
            <Search className="size-12 text-[color:var(--text-muted)]" />
            <p className="text-body text-muted-foreground">
              No rows match “{query}”.
            </p>
            <Link
              href={buildRateCardHref({ version: versionId })}
              className="text-body-sm font-semibold text-[color:var(--text-link)] hover:underline"
            >
              Clear filters
            </Link>
          </div>
        ) : (
          // Unfiltered and empty — a version normally has row_count > 0 rows, so
          // this is the page-past-the-last-page / genuinely-empty fallback,
          // distinct from the filter state above.
          <div className="flex flex-col items-center gap-2 bg-[color:var(--surface-sunken)] py-16 text-center">
            <Search className="size-12 text-[color:var(--text-muted)]" />
            <p className="text-body text-muted-foreground">
              No rows to show for this version.
            </p>
          </div>
        )
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-body">
            <thead>
              <tr className="border-b border-border bg-[color:var(--surface-sunken)]">
                {HEADERS.map((label) => (
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
              {rows.map((row) => (
                <tr
                  key={row.ratecardRanUsageLkpId}
                  className="border-b border-[color:var(--border-subtle)] last:border-0"
                >
                  <td className="px-4 py-2 font-mono text-mono">
                    {row.mnoPublicKey}
                  </td>
                  <td className="px-4 py-2 font-mono text-mono">
                    {row.commercialUnitPublicKey}
                  </td>
                  <td className="px-4 py-2 font-mono text-mono">
                    {row.polygonId}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap tabular-nums">
                    {formatCalendarDate(row.polygonStartDate, "iso")}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap tabular-nums">
                    {row.polygonEndDate === null ? (
                      <span className="text-[color:var(--text-muted)]">—</span>
                    ) : (
                      formatCalendarDate(row.polygonEndDate, "iso")
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <OptionalText value={row.state} />
                  </td>
                  <td className="px-4 py-2">
                    <OptionalText value={row.district} />
                  </td>
                  <td className="px-4 py-2 font-mono text-mono">
                    {row.lkpSubscriberRefId}
                  </td>
                  <td className="px-4 py-2 font-mono text-mono">
                    <OptionalText value={row.serviceCode} />
                  </td>
                  <td className="px-4 py-2 font-mono text-mono tabular-nums">
                    {row.ratePerUnit === null ? (
                      <span className="text-[color:var(--text-muted)]">—</span>
                    ) : (
                      row.ratePerUnit
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > 0 && (
        <ListPagination
          page={page}
          pageSize={pageSize}
          total={total}
          itemLabel="rows"
          hrefFor={(p) =>
            buildRateCardHref({ version: versionId, page: p, q: query })
          }
        />
      )}
    </div>
  );
}
