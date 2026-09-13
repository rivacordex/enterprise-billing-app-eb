import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The mutation controls import "use server" action modules; mock them so the
// test is a pure client render (the actions themselves keep the real
// ACCOUNTS_CONFIG:EDIT boundary — covered by the route-level matrix).
vi.mock("@/actions/accounts/upsert-reason-code.action", () => ({
  upsertReasonCodeAction: vi.fn(),
}));
vi.mock("@/actions/accounts/retire-reason-code.action", () => ({
  retireReasonCodeAction: vi.fn(),
}));
vi.mock("@/actions/accounts/upsert-bill-cycle.action", () => ({
  upsertBillCycleAction: vi.fn(),
}));
vi.mock("@/actions/accounts/retire-bill-cycle.action", () => ({
  retireBillCycleAction: vi.fn(),
}));
vi.mock("@/actions/accounts/set-wizard-defaults.action", () => ({
  setWizardDefaultsAction: vi.fn(),
}));

import {
  AddReasonCodeButton,
  ReasonCodeActions,
} from "@/components/accounts/reason-code-form";
import {
  AddBillCycleButton,
  BillCycleActions,
} from "@/components/accounts/bill-cycle-form";
import { WizardDefaultsForm } from "@/components/accounts/wizard-defaults-form";
import type { BillCycle, ReasonCode } from "@/types/accounts";

const REASON_ROW = {
  reasonCode: "GOODWILL_CREDIT",
  name: "Goodwill",
  description: null,
  docType: "ADJ",
  postingNature: "revenue_adj",
  autoPostLimit: "0.00",
  state: "active",
  lastModified: new Date("2026-01-01T00:00:00Z"),
} as unknown as ReasonCode;

const CYCLE_ROW = {
  billCycleId: "BCY00000001",
  name: "Monthly – Day 1",
  description: null,
  frequency: "monthly",
  cycleDay: 1,
  paymentDueDays: 30,
  state: "active",
  lastModified: new Date("2026-01-01T00:00:00Z"),
} as unknown as BillCycle;

function renderRow(node: React.ReactNode) {
  return render(
    <table>
      <tbody>{node}</tbody>
    </table>,
  );
}

describe("Accounts Settings controls — canEdit={false} disables every mutation trigger", () => {
  it("disables Add Reason Code", () => {
    render(<AddReasonCodeButton canEdit={false} />);
    expect(
      screen.getByRole("button", { name: "+ Add Reason Code" }),
    ).toBeDisabled();
  });

  it("disables Add Bill Cycle", () => {
    render(<AddBillCycleButton canEdit={false} />);
    expect(
      screen.getByRole("button", { name: "+ Add Bill Cycle" }),
    ).toBeDisabled();
  });

  it("disables the reason-code row Edit/Retire", () => {
    renderRow(<ReasonCodeActions row={REASON_ROW} canEdit={false} />);
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Retire" })).toBeDisabled();
  });

  it("disables the bill-cycle row Edit/Set Default/Retire", () => {
    renderRow(
      <BillCycleActions
        row={CYCLE_ROW}
        defaultBillCycleId={null}
        currentCreditLimit={null}
        canEdit={false}
      />,
    );
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Set Default" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Retire" })).toBeDisabled();
  });

  it("disables the Wizard Defaults controls (select, credit-limit input, submit)", () => {
    render(
      <WizardDefaultsForm
        activeCycles={[{ billCycleId: "BCY00000001", name: "Monthly – Day 1" }]}
        defaultBillCycleId="BCY00000001"
        defaultCurrency="MYR"
        defaultCreditLimit={null}
        canEdit={false}
      />,
    );
    expect(
      screen.getByRole("combobox", { name: "Default Bill Cycle *" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("textbox", { name: "Default Credit Limit (MYR)" }),
    ).toHaveAttribute("readonly");
    expect(
      screen.getByRole("button", { name: "Save Defaults" }),
    ).toBeDisabled();
  });
});

describe("Accounts Settings controls — canEdit={true} leaves every mutation trigger live", () => {
  it("enables Add Reason Code", () => {
    render(<AddReasonCodeButton canEdit={true} />);
    expect(
      screen.getByRole("button", { name: "+ Add Reason Code" }),
    ).toBeEnabled();
  });

  it("enables Add Bill Cycle", () => {
    render(<AddBillCycleButton canEdit={true} />);
    expect(
      screen.getByRole("button", { name: "+ Add Bill Cycle" }),
    ).toBeEnabled();
  });

  it("enables the reason-code row Edit/Retire", () => {
    renderRow(<ReasonCodeActions row={REASON_ROW} canEdit={true} />);
    expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Retire" })).toBeEnabled();
  });

  it("enables the bill-cycle row Edit/Set Default/Retire", () => {
    renderRow(
      <BillCycleActions
        row={CYCLE_ROW}
        defaultBillCycleId={null}
        currentCreditLimit={null}
        canEdit={true}
      />,
    );
    expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Set Default" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Retire" })).toBeEnabled();
  });

  it("enables the Wizard Defaults controls (select, credit-limit input, submit)", () => {
    render(
      <WizardDefaultsForm
        activeCycles={[{ billCycleId: "BCY00000001", name: "Monthly – Day 1" }]}
        defaultBillCycleId="BCY00000001"
        defaultCurrency="MYR"
        defaultCreditLimit={null}
        canEdit={true}
      />,
    );
    expect(
      screen.getByRole("combobox", { name: "Default Bill Cycle *" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("textbox", { name: "Default Credit Limit (MYR)" }),
    ).not.toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Save Defaults" })).toBeEnabled();
  });
});
