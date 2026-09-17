// bm10-spec §Visual/§Implementation §3. `PreApprovalChecks` renders each of
// the five checks as an explicit pass/fail row with a remediation line on
// failure only.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PreApprovalChecks } from "@/components/billing/pre-approval-checks";

describe("PreApprovalChecks (bm10-spec §Visual, bm17 adds a 6th)", () => {
  it("renders all six checks with their labels", () => {
    render(
      <PreApprovalChecks
        checks={[
          { check: "period_open", pass: true, remediation: null },
          { check: "gl_mappings", pass: true, remediation: null },
          { check: "positive_totals", pass: true, remediation: null },
          { check: "four_eyes", pass: true, remediation: null },
          { check: "accounts_terminal", pass: true, remediation: null },
          { check: "no_rejected_pending", pass: true, remediation: null },
        ]}
      />,
    );

    expect(screen.getByText("Accounting period open")).toBeTruthy();
    expect(screen.getByText("GL mappings resolvable")).toBeTruthy();
    expect(screen.getByText("No negative totals")).toBeTruthy();
    expect(
      screen.getByText("Approver differs from the trigger actor"),
    ).toBeTruthy();
    expect(screen.getByText("All accounts terminal")).toBeTruthy();
    expect(
      screen.getByText("No accounts pending reject-reprocess"),
    ).toBeTruthy();
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
          { check: "no_rejected_pending", pass: true, remediation: null },
        ]}
      />,
    );

    expect(screen.getByText("Period 2026-07 is closed for MYR.")).toBeTruthy();
  });

  // 2026-09-17 (owner decision) — the zero-total-bill line rides the bm32
  // informational contract: it always passes, yet its remediation IS rendered
  // (unlike a passing blocking check, whose remediation is hidden). That is the
  // whole point of the line — a zero-total bill stays visible to the approver
  // now that a line-less one no longer blocks.
  it("renders the zero-total-bill count as an informational line that still shows its text", () => {
    render(
      <PreApprovalChecks
        checks={[
          { check: "positive_totals", pass: true, remediation: null },
          {
            check: "zero_total_bills",
            pass: true,
            informational: true,
            remediation: "1 bill totals zero — informational.",
          },
        ]}
      />,
    );

    expect(screen.getByText("Zero-total bills")).toBeTruthy();
    expect(
      screen.getByText("1 bill totals zero — informational."),
    ).toBeTruthy();
  });
});
