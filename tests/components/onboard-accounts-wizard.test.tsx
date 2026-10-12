import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/actions/accounts/get-wizard-options", () => ({
  getWizardOptionsAction: vi.fn(),
}));
vi.mock("@/actions/accounts/onboard-customer-accounts", () => ({
  onboardCustomerAccountsAction: vi.fn(),
}));

import { getWizardOptionsAction } from "@/actions/accounts/get-wizard-options";
import { onboardCustomerAccountsAction } from "@/actions/accounts/onboard-customer-accounts";
import { OnboardAccountsWizard } from "@/components/customers/onboard-accounts-wizard";

// cm18-spec §3.5/§3.6 — read-only "Invoice template" field (O1), the wizard
// always submits billTemplateVersionId: null, and TEMPLATE_NOT_BINDABLE is
// surfaced as a plain-language error.
const mockGetWizardOptions = vi.mocked(getWizardOptionsAction);
const mockOnboard = vi.mocked(onboardCustomerAccountsAction);

const LOCK = new Date("2026-01-01T00:00:00.000Z");

function renderWizard() {
  return render(
    <OnboardAccountsWizard
      open
      partyRoleId="PTRL00000001"
      statusReason="All KYC checks passed."
      lastModifiedDatetime={LOCK}
      onSuccess={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
}

beforeEach(() => {
  mockGetWizardOptions.mockReset();
  mockOnboard.mockReset();
  mockGetWizardOptions.mockResolvedValue({
    activeCycles: [
      { billCycleId: "BCY000001", name: "Monthly – Day 1", paymentDueDays: 30 },
    ],
    defaults: {
      currency: "MYR",
      defaultBillCycleId: "BCY000001",
      defaultCreditLimit: null,
    },
    priorAccounts: [],
  });
});

describe("OnboardAccountsWizard — Invoice template field (cm18)", () => {
  it("renders the field read-only with its value and help text", async () => {
    renderWizard();

    const input = await screen.findByDisplayValue("Follow active template");
    expect(input).toHaveAttribute("readonly");
    expect(input).toHaveClass("bg-muted/50", "text-muted-foreground");
    expect(screen.getByText("Invoice template")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Invoices use the active template. Per-customer templates are not available yet.",
      ),
    ).toBeInTheDocument();
  });

  it("submits billTemplateVersionId: null", async () => {
    mockOnboard.mockResolvedValue({ ok: false, code: "CONFLICT" });
    renderWizard();

    await screen.findByDisplayValue("Follow active template");
    await userEvent.click(
      screen.getByRole("button", { name: "Set Up Accounts" }),
    );

    await waitFor(() => expect(mockOnboard).toHaveBeenCalledTimes(1));
    expect(mockOnboard).toHaveBeenCalledWith(
      expect.objectContaining({
        partyRoleId: "PTRL00000001",
        billTemplateVersionId: null,
      }),
    );
  });

  it("shows the message for a TEMPLATE_NOT_BINDABLE result", async () => {
    mockOnboard.mockResolvedValue({
      ok: false,
      code: "TEMPLATE_NOT_BINDABLE",
    });
    renderWizard();

    await screen.findByDisplayValue("Follow active template");
    await userEvent.click(
      screen.getByRole("button", { name: "Set Up Accounts" }),
    );

    expect(
      await screen.findByText(
        "This invoice template cannot be assigned. Please reload and try again.",
      ),
    ).toBeInTheDocument();
  });
});
