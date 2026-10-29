// The Workflow tab's run-level flow stepper (2026-09-18, redrawn 2026-10-27) —
// the nine pipeline steps in order on one rail, summarising where the WHOLE run
// stands, above the per-account grid. Server component; read-only. Semantic
// tokens only, and every state carries a glyph and a text label as well as a
// colour (ui-context "Rendering rule") so the stepper is not colour-only.
//
// The rail is drawn per step as two half-segments so it can be partially
// filled without measuring: the half after a step is filled when THAT step is
// `done`; the half before a step is filled when the PREVIOUS step is `done`.
// The first/last steps hide their outer half (`invisible`, not removed, so the
// dot stays centred over its label).
//
// `distribution` is the one step with no per-account column (see
// `TIMELINE_STAGES`): it is tracked per (target, artifact) in
// `bill_run_distribution`, and its run report belongs to no account at all. So
// when the run reaches it, the stepper points the operator at the Distribution
// tab, which holds the real per-artifact delivery log.

import Link from "next/link";
import { Check, Minus, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { STAGE_LABELS } from "@/types/billing";
import type { FlowStepState, RunFlowProgress } from "@/types/billing";

const DOT_TONES: Record<FlowStepState, string> = {
  done: "border-[color:var(--color-success-500)] bg-[color:var(--color-success-50)] text-[color:var(--color-success-700)]",
  current:
    "border-[color:var(--color-info-500)] bg-[color:var(--color-info-50)] text-[color:var(--color-info-700)]",
  failed:
    "border-[color:var(--color-danger-500)] bg-[color:var(--color-danger-50)] text-[color:var(--color-danger-700)]",
  skipped:
    "border-[color:var(--border-default)] bg-[color:var(--color-neutral-100)] text-[color:var(--text-disabled)]",
  pending:
    "border-[color:var(--border-default)] bg-[color:var(--surface-card)] text-muted-foreground",
};

const LABEL_TONES: Record<FlowStepState, string> = {
  done: "text-foreground",
  current: "font-medium text-[color:var(--color-info-700)]",
  failed: "font-medium text-[color:var(--color-danger-700)]",
  skipped: "text-muted-foreground",
  pending: "text-muted-foreground",
};

const STATE_LABELS: Record<FlowStepState, string> = {
  done: "done",
  current: "in progress",
  failed: "failed",
  skipped: "skipped",
  pending: "not started",
};

const RAIL_FILLED = "bg-[color:var(--color-success-500)]";
const RAIL_EMPTY = "bg-[color:var(--border-default)]";

// Glyph per state — paired with the colour, never the colour alone.
function StepGlyph({
  state,
}: {
  state: FlowStepState;
}): React.JSX.Element | null {
  switch (state) {
    case "done":
      return <Check size={14} aria-hidden="true" />;
    case "failed":
      return <X size={14} aria-hidden="true" />;
    case "skipped":
      return <Minus size={14} aria-hidden="true" />;
    case "current":
      return (
        <span
          aria-hidden="true"
          className="size-2 rounded-full bg-[color:var(--color-info-500)]"
        />
      );
    default:
      return null;
  }
}

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
      <div
        role="region"
        aria-label="Run pipeline stages"
        tabIndex={0}
        className="overflow-x-auto focus:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
      >
        <ol
          aria-label="Run pipeline progress"
          className="flex min-w-max items-start"
        >
          {flow.steps.map((step, i) => {
            const prev = flow.steps[i - 1];
            const isFirst = i === 0;
            const isLast = i === flow.steps.length - 1;
            return (
              <li
                key={step.stage}
                data-stage={step.stage}
                data-state={step.state}
                aria-current={
                  step.stage === flow.currentStage ? "step" : undefined
                }
                className="flex min-w-[5.5rem] flex-1 flex-col items-center"
              >
                <div className="flex w-full items-center">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "h-0.5 flex-1",
                      isFirst
                        ? "invisible"
                        : prev?.state === "done"
                          ? RAIL_FILLED
                          : RAIL_EMPTY,
                    )}
                  />
                  <span
                    className={cn(
                      "flex size-6 shrink-0 items-center justify-center rounded-full border-2",
                      DOT_TONES[step.state],
                    )}
                  >
                    <StepGlyph state={step.state} />
                  </span>
                  <span
                    aria-hidden="true"
                    className={cn(
                      "h-0.5 flex-1",
                      isLast
                        ? "invisible"
                        : step.state === "done"
                          ? RAIL_FILLED
                          : RAIL_EMPTY,
                    )}
                  />
                </div>
                <span
                  className={cn(
                    "mt-1.5 px-1 text-center text-body-sm",
                    LABEL_TONES[step.state],
                  )}
                >
                  {STAGE_LABELS[step.stage]}
                  <span className="sr-only"> — {STATE_LABELS[step.state]}</span>
                </span>
              </li>
            );
          })}
        </ol>
      </div>

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
