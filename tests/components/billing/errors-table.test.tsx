import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

// bm07-spec §Visual/§4. The Errors tab table: lists the PROCESSING_FAILED
// accounts with a HARD `ErrorClassBadge` + code/detail and a "Rerun these
// accounts" affordance (inert until bm08). Zero rows is a positive empty state.

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

describe("ErrorsTable (bm07-spec §Visual)", () => {
  it("renders each failed account with its stage, code, and detail", () => {
    const { container } = render(<ErrorsTable rows={[row()]} />);
    expect(container.textContent).toContain("Acme Sdn Bhd");
    expect(container.textContent).toContain("BAN00000001");
    expect(container.textContent).toContain("validation");
    expect(container.textContent).toContain("UNRESOLVABLE_PROFILE");
    expect(container.textContent).toContain("no currency");
    // The HARD ErrorClassBadge renders its label.
    expect(container.textContent).toContain("Hard");
  });

  it("shows a 'Rerun these accounts' affordance, disabled until bm08", () => {
    const { getByRole } = render(<ErrorsTable rows={[row()]} />);
    const button = getByRole("button", { name: /rerun these accounts/i });
    expect(button).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders a positive empty state when no account failed", () => {
    const { container } = render(<ErrorsTable rows={[]} />);
    expect(container.textContent).toContain("No blocking errors");
    expect(container.querySelector("table")).toBeNull();
  });
});
