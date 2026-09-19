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
import { STAGE_LABELS } from "@/types/billing";
import type { FlowStepState, RunFlowProgress } from "@/types/billing";

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
  // Only when distribution is genuinely IN PROGRESS. `currentStage` also anchors
  // on a FAILED step, so keying the hint on it would sit this calm, info-toned
  // copy over a failed delivery; gate on the step's own `current` state instead.
  // A failed/done distribution shows its own step marker, and the Distribution
  // tab stays reachable via the tab nav.
  const distributionStep = flow.steps.find((s) => s.stage === "distribution");
  const atDistribution = distributionStep?.state === "current";

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
            <span>{STAGE_LABELS[step.stage]}</span>
            <span className="sr-only"> — {STATE_LABELS[step.state]}</span>
          </li>
        ))}
      </ol>

      {atDistribution && (
        <p className="text-body-sm text-[color:var(--color-info-700)]">
          This run is at the distribution step. Delivery is tracked per
          artifact, not per account — open the{" "}
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
