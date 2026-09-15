import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

// bm07-spec §Visual, REDEFINED + EXTENDED by bm32 §4. The Uncharged tab renders
// TWO Info-family sections: (1) uncharged accounts (no charge line / nets to
// zero) with reason + window + a deep link to Accounts → Transactions, and
// (2) the per-record exception surface (BILL_NOTUSED rows + orphans), an
// unresolvable orphan shown by its subscriber ref. Each section has its own
// positive empty state.

// The CSV export button is a client leaf that imports the Server Action + sonner
// — stub it so this render test stays a pure presentational check.
vi.mock("@/components/billing/export-uncharged-button", () => ({
  ExportUnchargedButton: () => <div data-testid="export-uncharged" />,
}));

import { UnchargedTable } from "@/components/billing/uncharged-table";
import type { ExceptionRow, UnchargedRow } from "@/types/billing";

function row(overrides: Partial<UnchargedRow> = {}): UnchargedRow {
  return {
    billingAccountId: "BAN00000001",
    financialAccountId: "FIN00000001",
    accountName: "Acme Sdn Bhd",
    reason: "NO_CHARGE_LINES",
    windowStart: "2026-07-01",
    windowEnd: "2026-07-31",
    indicativeValue: null,
    ...overrides,
  };
}

function exception(overrides: Partial<ExceptionRow> = {}): ExceptionRow {
  return {
    kind: "BILL_NOTUSED",
    subscriberRef: "PRDINV00000001",
    accountName: "Acme Sdn Bhd",
    udrType: "RAN_USAGE",
    quantity: "10.000000",
    unit: "GB",
    ratedPrice: "5.00",
    currency: "MYR",
    ...overrides,
  };
}

describe("UnchargedTable (bm32-spec §4)", () => {
  it("renders each uncharged account with its reason and window", () => {
    const { container } = render(
      <UnchargedTable
        runId="BRN00000001"
        rows={[row()]}
        exceptions={[]}
        canRecover
        locale="en-MY"
      />,
    );
    expect(container.textContent).toContain("Acme Sdn Bhd");
    expect(container.textContent).toContain("BAN00000001");
    expect(container.textContent).toContain("NO_CHARGE_LINES");
  });

  it("renders the indicative value as '—' (no rating source)", () => {
    const { container } = render(
      <UnchargedTable
        runId="BRN00000001"
        rows={[row()]}
        exceptions={[]}
        canRecover
        locale="en-MY"
      />,
    );
    expect(container.textContent).toContain("—");
  });

  it("deep-links each uncharged row to Accounts → Transactions carrying the account context", () => {
    const { container } = render(
      <UnchargedTable
        runId="BRN00000001"
        rows={[row()]}
        exceptions={[]}
        canRecover
        locale="en-MY"
      />,
    );
    const link = container.querySelector(
      'a[href*="/accounts/transactions"]',
    ) as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toContain("fa=FIN00000001");
    expect(link?.getAttribute("href")).toContain("ban=BAN00000001");
  });

  it("renders the recovery affordance as a non-link when the viewer lacks Transactions access", () => {
    const { container } = render(
      <UnchargedTable
        runId="BRN00000001"
        rows={[row()]}
        exceptions={[]}
        canRecover={false}
        locale="en-MY"
      />,
    );
    expect(container.textContent).toContain("Manual DBN/ADJ");
    expect(
      container.querySelector('a[href*="/accounts/transactions"]'),
    ).toBeNull();
  });

  it("offers the CSV export control", () => {
    const { getByTestId } = render(
      <UnchargedTable
        runId="BRN00000001"
        rows={[row()]}
        exceptions={[]}
        canRecover
        locale="en-MY"
      />,
    );
    expect(getByTestId("export-uncharged")).toBeTruthy();
  });

  it("renders a positive empty state for both sections when there is nothing to show", () => {
    const { container } = render(
      <UnchargedTable
        runId="BRN00000001"
        rows={[]}
        exceptions={[]}
        canRecover
        locale="en-MY"
      />,
    );
    expect(container.textContent).toContain("No uncharged accounts");
    expect(container.textContent).toContain("No exceptions");
  });

  it("lists BILL_NOTUSED and orphan exceptions, an unresolvable orphan by its subscriber ref", () => {
    const { container } = render(
      <UnchargedTable
        runId="BRN00000001"
        rows={[]}
        exceptions={[
          exception(),
          exception({
            kind: "ORPHAN",
            subscriberRef: "PRDINV99999999",
            accountName: null,
          }),
        ]}
        canRecover
        locale="en-MY"
      />,
    );
    // The BILL_NOTUSED record with its resolved account name.
    expect(container.textContent).toContain("Not used");
    // The unresolvable orphan: no account name, shown by subscriber ref.
    expect(container.textContent).toContain("Orphan");
    expect(container.textContent).toContain("Unresolvable subscriber");
    expect(container.textContent).toContain("PRDINV99999999");
    // The rated value is rendered through formatCurrency (not the raw
    // "5.00 MYR" concatenation): the amount is present and the raw form is not.
    expect(container.textContent).toContain("5.00");
    expect(container.textContent).not.toContain("5.00 MYR");
  });
});
