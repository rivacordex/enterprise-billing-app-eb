import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

// bm07-spec §Visual/§4 + bm08 rerun wiring. The Errors tab table: lists the
// PROCESSING_FAILED accounts with a HARD `ErrorClassBadge` + code/detail. bm08
// wires the "Rerun these accounts" affordance to the live `RerunDialog` (the
// failed accounts, shown only to a billrun_operate principal). Zero rows is a
// positive empty state.

// Stub the client RerunDialog so the (server) table test stays focused and
// asserts the props it is wired with — no router/action graph loads.
vi.mock("@/components/billing/rerun-dialog", () => ({
  RerunDialog: (props: { billRunId: string; accountIds: string[] }) => (
    <div
      data-testid="rerun-dialog"
      data-run={props.billRunId}
      data-accounts={props.accountIds.join(",")}
    />
  ),
}));

import { ErrorsTable } from "@/components/billing/errors-table";
import type { ErrorRow } from "@/types/billing";

function row(overrides: Partial<ErrorRow> = {}): ErrorRow {
  return {
    billingAccountId: "BAN00000001",
    accountName: "Acme Sdn Bhd",
    stage: "validation",
    errorClass: "HARD",
    errorCode: "UNRESOLVABLE_PROFILE",
    errorDetail: "no currency",
    ...overrides,
  };
}

describe("ErrorsTable (bm07-spec §Visual, bm08 rerun wiring)", () => {
  it("renders each failed account with its stage, code, and detail", () => {
    const { container } = render(
      <ErrorsTable runId="BRN00000001" rows={[row()]} canOperate={false} />,
    );
    expect(container.textContent).toContain("Acme Sdn Bhd");
    expect(container.textContent).toContain("BAN00000001");
    expect(container.textContent).toContain("validation");
    expect(container.textContent).toContain("UNRESOLVABLE_PROFILE");
    expect(container.textContent).toContain("no currency");
    // The HARD ErrorClassBadge renders its label.
    expect(container.textContent).toContain("Hard");
  });

  it("wires the Rerun affordance to the failed accounts for an operator", () => {
    const { getByTestId } = render(
      <ErrorsTable
        runId="BRN00000001"
        rows={[row(), row({ billingAccountId: "BAN00000002" })]}
        canOperate={true}
      />,
    );
    const dialog = getByTestId("rerun-dialog");
    expect(dialog.getAttribute("data-run")).toBe("BRN00000001");
    expect(dialog.getAttribute("data-accounts")).toBe(
      "BAN00000001,BAN00000002",
    );
  });

  it("hides the Rerun affordance from a view-only (non-operator) principal", () => {
    const { queryByTestId } = render(
      <ErrorsTable runId="BRN00000001" rows={[row()]} canOperate={false} />,
    );
    expect(queryByTestId("rerun-dialog")).toBeNull();
  });

  it("renders a positive empty state when no account failed", () => {
    const { container } = render(
      <ErrorsTable runId="BRN00000001" rows={[]} canOperate={true} />,
    );
    expect(container.textContent).toContain("No blocking errors");
    expect(container.querySelector("table")).toBeNull();
  });
});
