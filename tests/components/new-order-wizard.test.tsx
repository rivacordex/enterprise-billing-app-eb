import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

vi.mock("@/actions/ordering/create-order.action", () => ({
  createOrderAction: vi.fn(),
}));

vi.mock("@/actions/accounts/new-order-wizard-reads", () => ({
  wizardSearchCustomersAction: vi.fn(),
  wizardGetCustomerAccountsAction: vi.fn(),
  wizardSearchOfferingsAction: vi.fn(),
  wizardGetOfferingDetailAction: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { createOrderAction } from "@/actions/ordering/create-order.action";
import {
  wizardGetCustomerAccountsAction,
  wizardGetOfferingDetailAction,
  wizardSearchCustomersAction,
  wizardSearchOfferingsAction,
} from "@/actions/accounts/new-order-wizard-reads";
import { toast } from "sonner";

import { NewOrderWizard } from "@/components/products/ordering/new-order-wizard";
import { Button } from "@/components/ui/button";

const mockCreateOrderAction = vi.mocked(createOrderAction);
const mockSearchCustomers = vi.mocked(wizardSearchCustomersAction);
const mockGetCustomerAccounts = vi.mocked(wizardGetCustomerAccountsAction);
const mockSearchOfferings = vi.mocked(wizardSearchOfferingsAction);
const mockGetOfferingDetail = vi.mocked(wizardGetOfferingDetailAction);
const mockToastSuccess = vi.mocked(toast.success);

const CUSTOMER = {
  partyRoleId: "PTRL00000001",
  organizationId: "ORG00000001",
  organizationName: "Acme Inc",
  tradingName: null,
  organizationStatus: "ACTIVE" as const,
  customerStatus: "ACTIVE" as const,
};

const ACCOUNT = {
  billingAccountId: "BAN00000001",
  name: "Acme main account",
  state: "active",
  currency: "USD",
  billCycleId: "BCY00000001",
  billCycleName: "Monthly",
  paymentTermsDays: 30,
};

const OFFERING = {
  productOfferingId: "PRDOFR00000001",
  name: "Fiber 100",
  version: 1,
};

const OFFERING_DETAIL = {
  productOfferingId: "PRDOFR00000001",
  name: "Fiber 100",
  isBundle: false,
  isSellable: true,
  billingOnly: true,
  lifecycleStatus: "ACTIVE" as const,
  version: 1,
  lastModified: new Date("2026-01-01"),
  lastEditedByName: null,
  specifications: [
    {
      productSpecId: "PRDSMD00000001",
      name: "Line spec",
      isMandatory: false,
      isDefault: false,
      defaultValue: null,
      characteristics: { SST_ID: "01" },
    },
  ],
  prices: [
    {
      productOfferingPriceId: "PRDOFP00000001",
      name: "Monthly fee",
      priceType: "recurring" as const,
      pricingModel: "flat" as const,
      amount: "50.00",
      currency: "USD",
      recurringChargePeriodLength: 1,
      recurringChargePeriodType: "month",
      unitOfMeasure: null,
      glCode: null,
      policy: null,
      pricingCharacteristics: null,
      startDateTime: new Date("2020-01-01"),
      createdAt: new Date("2020-01-01"),
      endDateTime: null,
      effectivityStatus: "current" as const,
    },
  ],
};

function renderWizard() {
  return render(
    <NewOrderWizard trigger={<Button>New order</Button>} locale="en-US" />,
  );
}

async function openAndSelectCustomer(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "New order" }));
  await user.type(screen.getByLabelText("Search customers"), "acme");
  await screen.findByText("Acme Inc", { exact: false });
  await user.click(screen.getByRole("button", { name: /Acme Inc/ }));
}

beforeEach(() => {
  mockRefresh.mockReset();
  mockCreateOrderAction.mockReset();
  mockSearchCustomers.mockReset();
  mockGetCustomerAccounts.mockReset();
  mockSearchOfferings.mockReset();
  mockGetOfferingDetail.mockReset();
  mockToastSuccess.mockReset();

  mockSearchCustomers.mockResolvedValue({
    results: [CUSTOMER],
    hasMore: false,
    limit: 5,
    query: "acme",
  });
  mockGetCustomerAccounts.mockResolvedValue({
    financialAccountId: "FA00000001",
    financialAccountName: "Acme financial account",
    bans: [ACCOUNT],
  });
  mockSearchOfferings.mockResolvedValue([OFFERING]);
  mockGetOfferingDetail.mockResolvedValue(OFFERING_DETAIL);
});

describe("NewOrderWizard — stepper navigation preserving state", () => {
  it("keeps the selected customer/account when navigating back and forward, without re-fetching", async () => {
    const user = userEvent.setup();
    renderWizard();

    await openAndSelectCustomer(user);
    await user.click(screen.getByRole("button", { name: "Next" }));

    // Step 2 — sole BAN auto-preselected.
    await waitFor(() =>
      expect(mockGetCustomerAccounts).toHaveBeenCalledWith("PTRL00000001"),
    );
    await screen.findByText(/Acme main account/);

    await user.click(screen.getByRole("button", { name: "Next" }));

    // Step 3 reached; go back twice to step 1.
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText(/Acme main account/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Selected:", { exact: false })).toHaveTextContent(
      "Acme Inc",
    );

    // Forward again to step 3 — the account fetch must not have re-run.
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(mockGetCustomerAccounts).toHaveBeenCalledTimes(1);
  });
});

describe("NewOrderWizard — override entry shows the approval banner", () => {
  async function reachStep3WithOffer(user: ReturnType<typeof userEvent.setup>) {
    await openAndSelectCustomer(user);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText(/Acme main account/);
    await user.click(screen.getByRole("button", { name: "Next" }));

    await user.type(screen.getByLabelText("Search offers"), "fiber");
    await screen.findByText("Fiber 100");
    await user.click(screen.getByRole("button", { name: /Fiber 100/ }));
    await screen.findByText("Current effective prices");
  }

  it("shows no banner until a negotiated amount is entered, then shows it", async () => {
    const user = userEvent.setup();
    renderWizard();

    await reachStep3WithOffer(user);

    expect(
      screen.queryByText(/requires manager approval/),
    ).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Negotiated amount (USD)"), "45.00");

    expect(
      await screen.findByText(/requires manager approval/),
    ).toBeInTheDocument();
  });
});

describe("NewOrderWizard — submit", () => {
  it("submits a standard order with the assembled payload and closes on success", async () => {
    mockCreateOrderAction.mockResolvedValue({
      ok: true,
      orderId: "PRDORD00000001",
      inventoryId: "PRDINV00000001",
      status: "COMPLETED",
    });
    const user = userEvent.setup();
    renderWizard();

    await openAndSelectCustomer(user);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText(/Acme main account/);
    await user.click(screen.getByRole("button", { name: "Next" }));

    await user.type(screen.getByLabelText("Search offers"), "fiber");
    await screen.findByText("Fiber 100");
    await user.click(screen.getByRole("button", { name: /Fiber 100/ }));
    await screen.findByText("Current effective prices");

    await user.click(screen.getByRole("button", { name: "Submit order" }));

    await waitFor(() => {
      expect(mockCreateOrderAction).toHaveBeenCalledWith(
        expect.objectContaining({
          customerPartyRoleId: "PTRL00000001",
          billingAccountId: "BAN00000001",
          productOfferingId: "PRDOFR00000001",
          quantity: 1,
          characteristics: { SST_ID: "01" },
          overrides: undefined,
        }),
      );
    });
    expect(mockToastSuccess).toHaveBeenCalledWith(
      "Order PRDORD00000001 completed",
    );
    expect(mockRefresh).toHaveBeenCalled();
  });
});
