// The bill-run list surfaces the run id as a drill-in link to the run detail
// page (where Approve & Post lives) — the list has no other navigation to the
// detail. Both surfaces are covered: the operable-run card (RunActionCard) and
// the plain rows in the historical/others table (RunsTable, inside BillRunList).
// Client children (router, export/trigger actions) are mocked so the db/service
// graph never loads.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/billing/bill-runs",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/actions/billing/trigger-run.action", () => ({
  triggerRunAction: vi.fn(),
}));
vi.mock("@/actions/billing/export-runs.action", () => ({
  exportRunsAction: vi.fn(),
}));

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RunActionCard } from "@/components/billing/run-action-card";
import { BillRunList } from "@/components/billing/bill-run-list";
import type { RunListRow, RunListPage } from "@/types/billing";

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

describe("bill-run list drill-in link", () => {
  it("RunActionCard renders the run id as a link to the run detail page", () => {
    render(<RunActionCard run={row} placeholderMode={false} />);

    const link = screen.getByRole("link", { name: "BRN00000001" });
    expect(link.getAttribute("href")).toBe("/billing/bill-runs/BRN00000001");
  });

  it("RunsTable rows render the run id as a link to the run detail page", () => {
    // A terminal run lands on the Historical tab, which renders the plain
    // RunsTable (no operable card) — the second linked surface.
    const historical: RunListPage = {
      tab: "historical",
      rows: [{ ...row, status: "COMPLETED", operable: false }],
      total: 1,
      page: 1,
      pageSize: 20,
    };

    render(
      <BillRunList
        page={historical}
        cycles={[]}
        hasCycles
        placeholderMode={false}
        activeCycle={null}
        activeStatus={null}
      />,
    );

    const link = screen.getByRole("link", { name: "BRN00000001" });
    expect(link.getAttribute("href")).toBe("/billing/bill-runs/BRN00000001");
  });
});
