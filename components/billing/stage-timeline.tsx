// bm04-spec §Visual — the Workflow tab's per-account stage grid: one row per
// scoped account, one column per `TimelineStage`, each cell a `StageStatusBadge`
// (+ `ErrorClassBadge` on a failure). The mid-flight summary ("N processed,
// M PROCESSING_FAILED") is per-row progress, never a global spinner — and
// always the caller's derived counts, never a stored cache
// (architecture Inv. #12). Server component; read-only.

import { AccountStatusBadge } from "@/components/billing/account-status-badge";
import { ErrorClassBadge } from "@/components/billing/error-class-badge";
import { StageStatusBadge } from "@/components/billing/stage-status-badge";
import { STAGE_LABELS, TIMELINE_STAGES } from "@/types/billing";
import type { StageTimelineRow, StageTimelineSummary } from "@/types/billing";

// No `distribution` column: it is tracked per (target, artifact) in
// `bill_run_distribution` — its run report belongs to no account — so a
// per-account cell could only ever be fabricated. The run-level flow bar above
// carries it and links to the Distribution tab instead. Labels come from the
// shared `STAGE_LABELS` (types/billing) so this header and the flow bar can
// never drift.

export interface StageTimelineProps {
  rows: StageTimelineRow[];
  summary: StageTimelineSummary;
}

export function StageTimeline({
  rows,
  summary,
}: StageTimelineProps): React.JSX.Element {
  return (
    <div className="space-y-3">
      <p className="text-body-sm text-muted-foreground">
        {summary.total === 0
          ? "No accounts were scoped into this run."
          : // Past the processing phase the counts all read zero (every account
            // has left `PROCESSED`), so the line is hidden rather than shown
            // contradicting the flow bar above it. The grid still tells the
            // per-account story.
            summary.isMidFlight
            ? `${summary.processed} processed, ${summary.processingFailed} processing failed` +
              (summary.excluded > 0 ? `, ${summary.excluded} excluded` : "") +
              ` of ${summary.total}.`
            : `${summary.total} account${summary.total === 1 ? "" : "s"} in this run.`}
      </p>

      {rows.length === 0 ? (
        <div className="rounded-none bg-card p-10 text-center shadow-sm">
          <p className="text-body font-semibold text-foreground">
            No accounts to show
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-none bg-card shadow-sm">
          <table className="w-full border-collapse text-body-sm">
            <thead>
              <tr className="border-b border-border bg-[color:var(--surface-sunken)]">
                <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                  Account
                </th>
                <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                  Status
                </th>
                {TIMELINE_STAGES.map((stage) => (
                  <th
                    key={stage}
                    className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase"
                  >
                    {STAGE_LABELS[stage]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.billingAccountId}
                  className="border-b border-[color:var(--border-subtle)] hover:bg-[color:var(--color-neutral-50)]"
                >
                  <td className="px-4 py-3 whitespace-nowrap">
                    <span className="font-mono text-mono text-foreground">
                      {row.billingAccountId}
                    </span>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <AccountStatusBadge status={row.accountStatus} />
                  </td>
                  {row.cells.map((cell) => (
                    <td
                      key={cell.stage}
                      className="px-4 py-3 whitespace-nowrap"
                    >
                      <div className="flex flex-col items-start gap-1">
                        <StageStatusBadge status={cell.status} />
                        {cell.errorClass && (
                          <ErrorClassBadge errorClass={cell.errorClass} />
                        )}
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
