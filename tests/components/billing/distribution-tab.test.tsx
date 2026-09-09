// bm20-spec §Visual/D-T3, CodeRabbit review (2026-09-09). A COMPLETED run can
// be reached two ways: every mandatory artifact actually DELIVERED, or T11's
// force-complete/abandon path, which leaves the last round's failed
// artifacts recorded as permanent FAILED rows. The tab must never claim
// "every mandatory artifact was delivered" over artifacts that were actually
// abandoned. The action-backed child controls are mocked so their db/service
// graph never loads (same convention as `rerun-dialog.test.tsx`).

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/actions/billing/start-distribution.action", () => ({
  startDistributionAction: vi.fn(),
}));
vi.mock("@/actions/billing/rerun-distribution.action", () => ({
  rerunDistributionAction: vi.fn(),
}));
vi.mock("@/actions/billing/force-complete-distribution.action", () => ({
  forceCompleteDistributionAction: vi.fn(),
}));

import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

import { DistributionTab } from "@/components/billing/distribution-tab";
import type { DistributionRow, DistributionView } from "@/types/billing";

function row(overrides: Partial<DistributionRow> = {}): DistributionRow {
  return {
    billRunDistributionId: "BRD00000001",
    target: "loopback",
    artifactRef: "REPORT",
    artifactType: "report_csv",
    isMandatory: true,
    outcome: "DELIVERED",
    at: new Date("2026-07-01T00:00:00Z"),
    distributionAttempt: 1,
    ...overrides,
  };
}

function view(overrides: Partial<DistributionView> = {}): DistributionView {
  return {
    billRunId: "BRN00000001",
    runStatus: "COMPLETED",
    hasExecution: true,
    targets: [{ name: "loopback", isMandatory: true }],
    rows: [],
    ...overrides,
  };
}

describe("DistributionTab COMPLETED messaging (bm20-spec §Visual)", () => {
  it("shows the fully-delivered success message when nothing in the latest attempt failed", () => {
    const { getByText, queryByText } = render(
      <DistributionTab
        view={view({ rows: [row({ outcome: "DELIVERED" })] })}
        canOperate={false}
        canApprove={false}
        locale="en-MY"
        timezone="Asia/Kuala_Lumpur"
      />,
    );

    expect(getByText(/every mandatory artifact was delivered/i)).toBeTruthy();
    expect(queryByText(/abandoned/i)).toBeNull();
  });

  it("shows an abandonment message (never the delivered-success copy) when the latest attempt has a FAILED artifact", () => {
    const { getByText, getAllByText, queryByText } = render(
      <DistributionTab
        view={view({
          rows: [
            row({
              billRunDistributionId: "BRD00000001",
              artifactRef: "REPORT",
              outcome: "FAILED",
              distributionAttempt: 1,
            }),
          ],
        })}
        canOperate={false}
        canApprove={false}
        locale="en-MY"
        timezone="Asia/Kuala_Lumpur"
      />,
    );

    expect(getByText(/abandoned/i)).toBeTruthy();
    // "REPORT" appears both in the abandonment message and the delivery
    // log's artifact-ref cell — just confirm it's named somewhere.
    expect(getAllByText(/REPORT/).length).toBeGreaterThan(0);
    expect(queryByText(/every mandatory artifact was delivered/i)).toBeNull();
  });

  it("ignores a FAILED row from a SUPERSEDED (earlier) attempt once a later attempt delivered it", () => {
    const { getByText, queryByText } = render(
      <DistributionTab
        view={view({
          rows: [
            row({
              billRunDistributionId: "BRD00000001",
              artifactRef: "REPORT",
              outcome: "FAILED",
              distributionAttempt: 1,
            }),
            row({
              billRunDistributionId: "BRD00000002",
              artifactRef: "REPORT",
              outcome: "DELIVERED",
              distributionAttempt: 2,
            }),
          ],
        })}
        canOperate={false}
        canApprove={false}
        locale="en-MY"
        timezone="Asia/Kuala_Lumpur"
      />,
    );

    expect(getByText(/every mandatory artifact was delivered/i)).toBeTruthy();
    expect(queryByText(/abandoned/i)).toBeNull();
  });
});
