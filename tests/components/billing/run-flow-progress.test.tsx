import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RunFlowProgressBar } from "@/components/billing/run-flow-progress";
import { STAGES } from "@/types/billing";
import type { RunFlowStep } from "@/types/billing";

// 2026-09-18 — the run-level flow bar above the per-account grid. The
// distribution hint is the point of the component: distribution is the one step
// with no per-account column, so when the run is there the operator has to be
// sent to the Distribution tab for the real per-artifact log.

function steps(overrides: Partial<Record<string, RunFlowStep["state"]>> = {}) {
  return STAGES.map((stage) => ({
    stage,
    state: overrides[stage] ?? ("pending" as RunFlowStep["state"]),
  }));
}

describe("RunFlowProgressBar", () => {
  it("renders every pipeline step in flow order", () => {
    render(
      <RunFlowProgressBar
        runId="BRN00000001"
        flow={{ steps: steps(), currentStage: "scoping" }}
      />,
    );

    for (const label of [
      "Scoping",
      "Validation",
      "Collection",
      "Aggregation",
      "Taxation",
      "Verification",
      "Posting",
      "Rendering",
      "Distribution",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("points the operator at the Distribution tab once the run reaches distribution", () => {
    render(
      <RunFlowProgressBar
        runId="BRN00000001"
        flow={{
          steps: steps({ distribution: "current" }),
          currentStage: "distribution",
        }}
      />,
    );

    const link = screen.getByRole("link", { name: "Distribution tab" });
    expect(link.getAttribute("href")).toBe(
      "/billing/bill-runs/BRN00000001?tab=distribution",
    );
  });

  it("does not show the distribution hint before the run gets there", () => {
    render(
      <RunFlowProgressBar
        runId="BRN00000001"
        flow={{
          steps: steps({ posting: "current" }),
          currentStage: "posting",
        }}
      />,
    );

    expect(screen.queryByRole("link", { name: "Distribution tab" })).toBeNull();
  });

  it("does NOT show the calm distribution hint when distribution FAILED", () => {
    // A DISTRIBUTION_FAILED run anchors currentStage on 'distribution', but the
    // step is 'failed', not 'current' — the info-toned "at the distribution
    // step" copy must never sit over a failed delivery.
    render(
      <RunFlowProgressBar
        runId="BRN00000001"
        flow={{
          steps: steps({ distribution: "failed" }),
          currentStage: "distribution",
        }}
      />,
    );

    expect(screen.queryByRole("link", { name: "Distribution tab" })).toBeNull();
    expect(screen.getByText("— failed")).toBeTruthy();
  });

  // ui-context "Rendering rule" — state is never conveyed by colour alone.
  it("labels each step's state for assistive tech", () => {
    render(
      <RunFlowProgressBar
        runId="BRN00000001"
        flow={{
          steps: steps({ scoping: "done", validation: "failed" }),
          currentStage: "validation",
        }}
      />,
    );

    expect(screen.getByText("— done")).toBeTruthy();
    expect(screen.getByText("— failed")).toBeTruthy();
  });
});
