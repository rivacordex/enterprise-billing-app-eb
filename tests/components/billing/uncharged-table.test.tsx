import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

// bm07-spec §Visual/§4. The Uncharged tab table: lists the EXCLUDED accounts
// with reason + window, renders the "—" indicative value, and deep-links each
// row to Accounts → Transactions carrying the account context (fa + ban). Zero
// rows is a positive empty state.

// The CSV export button is a client leaf that imports the Server Action + sonner
// — stub it so this render test stays a pure presentational check.
vi.mock("@/components/billing/export-uncharged-button", () => ({
  ExportUnchargedButton: () => <div data-testid="export-uncharged" />,
}));

import { UnchargedTable } from "@/components/billing/uncharged-table";
import type { UnchargedRow } from "@/types/billing";

function row(overrides: Partial<UnchargedRow> = {}): UnchargedRow {
  return {
    billingAccountId: "BAN00000001",
    financialAccountId: "FIN00000001",
    accountName: "Acme Sdn Bhd",
    reason: "PARTIAL_PERIOD",
    windowStart: "2026-07-01",
    windowEnd: "2026-07-31",
    indicativeValue: null,
    ...overrides,
  };
}

describe("UnchargedTable (bm07-spec §Visual)", () => {
  it("renders each excluded account with its reason and window", () => {
    const { container } = render(
      <UnchargedTable runId="BRN00000001" rows={[row()]} canRecover />,
    );
    expect(container.textContent).toContain("Acme Sdn Bhd");
    expect(container.textContent).toContain("BAN00000001");
    expect(container.textContent).toContain("PARTIAL_PERIOD");
  });

  it("renders the indicative value as '—' (no rating source in v1)", () => {
    const { container } = render(
      <UnchargedTable runId="BRN00000001" rows={[row()]} canRecover />,
    );
    expect(container.textContent).toContain("—");
  });

  it("deep-links each row to Accounts → Transactions carrying the account context", () => {
    const { container } = render(
      <UnchargedTable runId="BRN00000001" rows={[row()]} canRecover />,
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
      <UnchargedTable runId="BRN00000001" rows={[row()]} canRecover={false} />,
    );
    // The guidance text is still shown, but it does not dead-end at a link the
    // billrun_view-only viewer cannot follow.
    expect(container.textContent).toContain("Manual DBN/ADJ");
    expect(
      container.querySelector('a[href*="/accounts/transactions"]'),
    ).toBeNull();
  });

  it("offers the CSV export control", () => {
    const { getByTestId } = render(
      <UnchargedTable runId="BRN00000001" rows={[row()]} canRecover />,
    );
    expect(getByTestId("export-uncharged")).toBeTruthy();
  });

  it("renders a positive empty state when nothing was excluded", () => {
    const { container } = render(
      <UnchargedTable runId="BRN00000001" rows={[]} canRecover />,
    );
    expect(container.textContent).toContain("No uncharged accounts");
    expect(container.querySelector("table")).toBeNull();
  });
});
