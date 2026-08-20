// bm02-spec §6 (Design §Operability), bm03-spec §Visual. The operable-run
// surface on the Current & Upcoming tab — the single operable run per cycle.
// Server component: the Deep-Petrol "Run" CTA + its confirm dialog are the
// `TriggerRunDialog` interaction leaf (code-standards §3.7). Period columns
// render as calendar dates (`dd Mon yyyy`); no money is shown (bm02-spec
// §Visual).

import { RunStatusBadge } from "@/components/billing/run-status-badge";
import { StubBadge } from "@/components/billing/stub-data-banner";
import { TriggerRunDialog } from "@/components/billing/trigger-run-dialog";
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

        <TriggerRunDialog
          billRunId={run.billRunId}
          cycleName={run.cycleName}
          periodStart={run.periodStart}
          periodEnd={run.periodEnd}
        />
      </div>
    </div>
  );
}
