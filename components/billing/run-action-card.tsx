// bm02-spec §6 (Design §Operability). The operable-run surface on the Current
// & Upcoming tab — the single operable run per cycle. Server component: the
// "Run" button is INERT in bm02 (the Run action, and its Deep Petrol featured
// CTA styling, land in bm03). Period columns render as calendar dates
// (`dd Mon yyyy`); no money is shown (bm02-spec §Visual).

import { Play } from "lucide-react";

import { RunStatusBadge } from "@/components/billing/run-status-badge";
import { StubBadge } from "@/components/billing/stub-data-banner";
import { formatCalendarDate } from "@/lib/formatters";
import type { RunListRow } from "@/types/billing";

export interface RunActionCardProps {
  run: RunListRow;
  stubDataMode: boolean;
}

export function RunActionCard({
  run,
  stubDataMode,
}: RunActionCardProps): React.JSX.Element {
  return (
    <div className="rounded-md border border-[color:var(--color-primary-200)] bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-mono text-foreground">
              {run.billRunId}
            </span>
            <RunStatusBadge status={run.status} />
            {stubDataMode && <StubBadge />}
          </div>
          <div className="text-body-sm text-muted-foreground">
            Period{" "}
            <span className="font-medium text-foreground">
              {formatCalendarDate(run.periodStart)}
            </span>{" "}
            –{" "}
            <span className="font-medium text-foreground">
              {formatCalendarDate(run.periodEnd)}
            </span>
          </div>
          <div className="text-body-sm text-muted-foreground">
            Scheduled run date{" "}
            <span className="font-medium text-foreground">
              {formatCalendarDate(run.scheduledRunDate)}
            </span>
          </div>
        </div>

        {/* Inert in bm02 — the Run action arrives in bm03. Disabled so the
            operable surface is visible without offering a non-functional
            control. */}
        <button
          type="button"
          disabled
          aria-disabled="true"
          title="Running a bill run is not available yet."
          className="inline-flex items-center gap-1.5 rounded-md bg-[color:var(--color-primary-600)] px-4 py-2 text-body-sm font-semibold text-[color:var(--color-primary-50)] opacity-50"
        >
          <Play size={14} aria-hidden="true" />
          Run
        </button>
      </div>
    </div>
  );
}
