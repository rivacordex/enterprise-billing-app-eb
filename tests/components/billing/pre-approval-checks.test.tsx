// bm10-spec §Visual/§Implementation §3. `PreApprovalChecks` renders each of
// the five checks as an explicit pass/fail row with a remediation line on
// failure only.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PreApprovalChecks } from "@/components/billing/pre-approval-checks";

describe("PreApprovalChecks (bm10-spec §Visual)", () => {
  it("renders all five checks with their labels", () => {
    render(
      <PreApprovalChecks
        checks={[
          { check: "period_open", pass: true, remediation: null },
          { check: "gl_mappings", pass: true, remediation: null },
          { check: "positive_totals", pass: true, remediation: null },
          { check: "four_eyes", pass: true, remediation: null },
          { check: "accounts_terminal", pass: true, remediation: null },
        ]}
      />,
    );

    expect(screen.getByText("Accounting period open")).toBeTruthy();
    expect(screen.getByText("GL mappings resolvable")).toBeTruthy();
    expect(screen.getByText("No zero or negative totals")).toBeTruthy();
    expect(
      screen.getByText("Approver differs from the trigger actor"),
    ).toBeTruthy();
    expect(screen.getByText("All accounts terminal")).toBeTruthy();
  });

  it("shows a remediation line only for a failing check", () => {
    render(
      <PreApprovalChecks
        checks={[
          {
            check: "period_open",
            pass: false,
            remediation: "Period 2026-07 is closed for MYR.",
          },
          { check: "gl_mappings", pass: true, remediation: null },
          { check: "positive_totals", pass: true, remediation: null },
          { check: "four_eyes", pass: true, remediation: null },
          { check: "accounts_terminal", pass: true, remediation: null },
        ]}
      />,
    );

    expect(screen.getByText("Period 2026-07 is closed for MYR.")).toBeTruthy();
  });
});
