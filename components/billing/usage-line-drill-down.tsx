"use client";

// bm28-spec §Design/§Implementation §5 (+ code-review fix #2/#3/#5) — the
// `udr_rated` drill-down behind a USAGE line. A native `<details>` disclosure
// that fetches its rated records ONLY on expand (the bm18 fetch-on-open pattern,
// `fetchRatedLinesAction` → `ratedLinesRepository.listClaimedForLine`), never
// eagerly: a volume account can sit behind thousands of records, so nothing
// loads until the reviewer asks. Client leaf (the fetch-on-toggle interaction)
// under the server `BillLineTable` (code-standards §3.7). The fetch is scoped
// SERVER-SIDE to this line's grain (`productOfferingId`, `udrType`), so the
// disclosure shows exactly this line's records and only this line's records are
// transferred — no whole-account fetch, no client-side filtering. Fetched once
// per open per line, then cached in state; re-collapsing keeps the rows.

import { useRef, useState } from "react";

import { fetchRatedLinesAction } from "@/actions/billing/fetch-rated-lines.action";
import { formatCurrency, formatDatetime } from "@/lib/formatters";
import type { RatedLineRow } from "@/types/billing";

export interface UsageLineDrillDownProps {
  billRunId: string;
  billingAccountId: string;
  productOfferingId: string;
  udrType: string;
  locale: string;
  timezone: string;
}

type LoadState = "idle" | "loading" | "ready" | "error" | "forbidden";

export function UsageLineDrillDown({
  billRunId,
  billingAccountId,
  productOfferingId,
  udrType,
  locale,
  timezone,
}: UsageLineDrillDownProps): React.JSX.Element {
  const [state, setState] = useState<LoadState>("idle");
  const [rows, setRows] = useState<RatedLineRow[]>([]);
  // Fetch at most once per line — a re-open after a collapse reuses the rows.
  const loadedRef = useRef(false);

  async function handleToggle(
    event: React.SyntheticEvent<HTMLDetailsElement>,
  ): Promise<void> {
    if (!event.currentTarget.open || loadedRef.current) return;
    loadedRef.current = true;
    setState("loading");
    try {
      const result = await fetchRatedLinesAction({
        runId: billRunId,
        billingAccountId,
        productOfferingId,
        udrType,
      });
      if (!result.ok) {
        // Allow a retry on failure — a forbidden/invalid read shouldn't wedge
        // the disclosure permanently closed to its own data.
        loadedRef.current = false;
        setState(result.code === "FORBIDDEN" ? "forbidden" : "error");
        return;
      }
      // Already scoped to this line's (offering, udr_type) server-side.
      setRows(result.rows);
      setState("ready");
    } catch {
      // The server action REJECTED (an unexpected server/DB error, or a
      // non-redirect throw from the permission guard) rather than returning a
      // typed { ok: false }. Reset loadedRef so re-opening the disclosure
      // retries, and surface the error state instead of a frame stuck on
      // "loading" forever.
      loadedRef.current = false;
      setState("error");
    }
  }

  return (
    <details
      onToggle={(event) => {
        void handleToggle(event);
      }}
      className="text-body-sm"
    >
      <summary className="cursor-pointer text-body-sm text-[color:var(--color-primary-600)] select-none hover:underline">
        View usage records
      </summary>
      <div className="mt-2">
        {state === "loading" && (
          <p role="status" aria-live="polite" className="text-muted-foreground">
            Loading usage records…
          </p>
        )}
        {state === "error" && (
          <p className="text-destructive">
            Could not load usage records. Expand again to retry.
          </p>
        )}
        {state === "forbidden" && (
          <p className="text-destructive">
            You do not have permission to view these usage records.
          </p>
        )}
        {state === "ready" && rows.length === 0 && (
          <p className="text-muted-foreground">
            No claimed usage records for this line.
          </p>
        )}
        {state === "ready" && rows.length > 0 && (
          <table className="w-full border-collapse text-caption">
            <thead>
              <tr className="border-b border-[color:var(--border-subtle)] text-muted-foreground">
                <th className="px-2 py-1 text-left font-medium">Record</th>
                <th className="px-2 py-1 text-left font-medium">Start</th>
                <th className="px-2 py-1 text-right font-medium">Quantity</th>
                <th className="px-2 py-1 text-right font-medium">Rated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.udrId}
                  className="border-b border-[color:var(--border-subtle)]"
                >
                  <td className="px-2 py-1 font-mono text-mono text-muted-foreground">
                    {row.udrId}
                  </td>
                  <td className="px-2 py-1 whitespace-nowrap text-muted-foreground">
                    {formatDatetime(
                      new Date(row.startDatetime),
                      locale,
                      timezone,
                    )}
                  </td>
                  <td className="px-2 py-1 text-right whitespace-nowrap tabular-nums">
                    {row.udrUsageQuantity} {row.udrUsageUnit}
                  </td>
                  <td className="px-2 py-1 text-right whitespace-nowrap tabular-nums">
                    {formatCurrency(row.udrRatedPrice, row.udrCurrency, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </details>
  );
}
