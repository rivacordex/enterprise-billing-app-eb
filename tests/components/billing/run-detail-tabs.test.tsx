import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RunDetailTabs } from "@/components/billing/run-detail-tabs";
import { STAGES } from "@/types/billing";
import type { RunDetailTabsProps } from "@/components/billing/run-detail-tabs";
import type { RunStatus } from "@/types/billing";

// 2026-09-18 — the Workflow tab composes the run-level flow bar over the
// per-account grid. A CANCELLED run was reset (accounts back to PENDING), so the
// pipeline-progress bar would read as in-progress; the tab suppresses it and
// shows a plain note instead (the grid below still reflects the reset state).

function props(runStatus: RunStatus): RunDetailTabsProps {
  return {
    runId: "BRN00000001",
    runStatus,
    activeTab: "workflow",
    timeline: {
      rows: [],
      summary: {
        total: 0,
        processed: 0,
        processingFailed: 0,
        excluded: 0,
        isMidFlight: false,
      },
      flow: {
        steps: STAGES.map((stage) => ({ stage, state: "pending" as const })),
        currentStage: "scoping",
      },
    },
    customerBills: [],
    uncharged: [],
    exceptions: [],
    errors: [],
    rejectedPending: [],
    distribution: null,
    audit: [],
    canRecover: false,
    canRerun: false,
    canOperate: false,
    canApprove: false,
    locale: "en-US",
    timezone: "UTC",
  };
}

describe("RunDetailTabs — Workflow tab flow bar", () => {
  it("renders the flow bar for a non-cancelled run", () => {
    render(<RunDetailTabs {...props("PROCESSING")} />);

    // The bar renders every pipeline step; "Scoping" is unique to it here.
    expect(screen.getByText("Scoping")).toBeTruthy();
    expect(screen.queryByText(/This run was cancelled/)).toBeNull();
  });

  it("suppresses the flow bar and shows a note for a CANCELLED run", () => {
    render(<RunDetailTabs {...props("CANCELLED")} />);

    expect(screen.getByText(/This run was cancelled/)).toBeTruthy();
    // No flow-bar steps rendered.
    expect(screen.queryByText("Scoping")).toBeNull();
  });
});
