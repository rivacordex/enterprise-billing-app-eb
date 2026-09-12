// The operable-run card surfaces the run id as a drill-in link to the run
// detail page (where Approve & Post lives) — the list has no other navigation
// to the detail. The trigger action + router are mocked so the db/service
// graph never loads.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/actions/billing/trigger-run.action", () => ({
  triggerRunAction: vi.fn(),
}));

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RunActionCard } from "@/components/billing/run-action-card";
import type { RunListRow } from "@/types/billing";

const row: RunListRow = {
  billRunId: "BRN00000001",
  cycleId: "BCY00000001",
  cycleName: "Monthly – Day 1",
  periodStart: "2026-08-01",
  periodEnd: "2026-08-31",
  scheduledRunDate: "2026-09-01",
  status: "PROCESSED",
  runType: "onCycle",
  operable: true,
  pastDue: true,
};

describe("RunActionCard drill-in link", () => {
  it("renders the run id as a link to the run detail page", () => {
    render(<RunActionCard run={row} placeholderMode={false} />);

    const link = screen.getByRole("link", { name: "BRN00000001" });
    expect(link.getAttribute("href")).toBe("/billing/bill-runs/BRN00000001");
  });
});
