// The Workflow tab's run-level flow bar (2026-09-18) — the nine pipeline steps
// in order, summarising where the WHOLE run stands, above the per-account grid.
// Server component; read-only. Semantic tokens only, and every state carries a
// shape/label as well as a colour (ui-context "Rendering rule") so the bar is
// not colour-only.
//
// `distribution` is the one step with no per-account column (see
// `TIMELINE_STAGES`): it is tracked per (target, artifact) in
// `bill_run_distribution`, and its run report belongs to no account at all. So
// when the run reaches it, the bar points the operator at the Distribution tab,
// which holds the real per-artifact delivery log.

import Link from "next/link";

import { cn } from "@/lib/utils";
import type { FlowStepState, RunFlowProgress } from "@/types/billing";

const STEP_LABELS: Record<string, string> = {
  scoping: "Scoping",
  validation: "Validation",
  collection: "Collection",
  aggregation: "Aggregation",
  taxation: "Taxation",
  verification: "Verification",
  posting: "Posting",
  rendering: "Rendering",
  distribution: "Distribution",
};

// Marker glyph per state — paired with the colour, never the colour alone.
const STEP_MARKS: Record<FlowStepState, string> = {
  done: "✓",
  current: "●",
  failed: "✕",
  skipped: "–",
  pending: "○",
};

const STEP_TONES: Record<FlowStepState, string> = {
  done: "border-[color:var(--color-success-500)] text-[color:var(--color-success-700)]",
  current:
    "border-[color:var(--color-info-500)] text-[color:var(--color-info-700)] font-medium",
  failed:
    "border-[color:var(--color-danger-500)] text-[color:var(--color-danger-700)] font-medium",
  skipped: "border-[color:var(--border-default)] text-muted-foreground",
  pending: "border-[color:var(--border-default)] text-muted-foreground",
};

const STATE_LABELS: Record<FlowStepState, string> = {
  done: "done",
  current: "in progress",
  failed: "failed",
  skipped: "skipped",
  pending: "not started",
};

export interface RunFlowProgressBarProps {
  runId: string;
  flow: RunFlowProgress;
  className?: string;
}

export function RunFlowProgressBar({
  runId,
  flow,
  className,
}: RunFlowProgressBarProps): React.JSX.Element {
  const atDistribution = flow.currentStage === "distribution";

  return (
    <div className={cn("space-y-3", className)}>
      <ol className="flex flex-wrap items-stretch gap-1.5">
        {flow.steps.map((step) => (
          <li
            key={step.stage}
            className={cn(
              "flex items-center gap-1.5 rounded-md border-l-2 bg-[color:var(--surface-card)] px-2.5 py-1.5 text-body-sm",
              STEP_TONES[step.state],
            )}
          >
            <span aria-hidden="true">{STEP_MARKS[step.state]}</span>
            <span>{STEP_LABELS[step.stage] ?? step.stage}</span>
            <span className="sr-only"> — {STATE_LABELS[step.state]}</span>
          </li>
        ))}
      </ol>

      {atDistribution && (
        <p className="text-body-sm text-[color:var(--color-info-700)]">
          This run is at the distribution step. Delivery is tracked per artifact,
          not per account — open the{" "}
          <Link
            href={`/billing/bill-runs/${runId}?tab=distribution`}
            className="underline underline-offset-2"
          >
            Distribution tab
          </Link>{" "}
          for the per-artifact delivery log and the rerun controls.
        </p>
      )}
    </div>
  );
}
