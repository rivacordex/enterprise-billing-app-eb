import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// pm41 I6, reworked pm54/pm55 for the pricing-components update.
// ManagePricesPanel stays a server component; its editable client leaf
// (EditablePrices) is exercised here with the three price actions +
// next/navigation + sonner mocked. Fake timers pin "now" so the reused
// PriceForm's backdating logic is deterministic.
const mockRefresh = vi.fn();
const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh, push: mockPush }),
}));

vi.mock("@/actions/product/insert-price.action", () => ({
  insertPriceAction: vi.fn(),
}));
vi.mock("@/actions/product/update-price.action", () => ({
  updatePriceAction: vi.fn(),
}));
vi.mock("@/actions/product/delete-price.action", () => ({
  deletePriceAction: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { deletePriceAction } from "@/actions/product/delete-price.action";
import { insertPriceAction } from "@/actions/product/insert-price.action";
import { updatePriceAction } from "@/actions/product/update-price.action";
import { ManagePricesPanel } from "@/components/products/manage/manage-prices-panel";
import type { PriceCard } from "@/types/product";

const mockInsert = vi.mocked(insertPriceAction);
const mockUpdate = vi.mocked(updatePriceAction);
const mockDelete = vi.mocked(deletePriceAction);

const OFFERING_ID = "PRDOFR000001";
const FAMILY_ID = "PRDOFR000001";
const LOCALE = "en-US";
const TIMEZONE = "UTC";
const FIXED_NOW = new Date(2026, 6, 23, 0, 0, 0);

function usageRatePrice(overrides: Partial<PriceCard> = {}): PriceCard {
  return {
    productOfferingPriceId: "PRDOFP000001",
    name: "Base usage rate",
    componentType: "usage_rate",
    component: {
      "@type": "usage_rate",
      specVersion: 1,
      plaSpecId: null,
      priceType: "usage",
      appliesAt: "rating",
      basis: "quantity",
      boundTo: { unitOfMeasure: "EA" },
      params: { ratePerUnit: "100", rateCardLookUp: null },
    },
    currency: "MYR",
    unitOfMeasure: "EA",
    recurringChargePeriodLength: null,
    recurringChargePeriodType: null,
    glCode: "GL-4100",
    policy: null,
    startDateTime: new Date(2026, 6, 23),
    createdAt: new Date(2026, 6, 23),
    endDateTime: null,
    effectivityStatus: "current",
    ...overrides,
  };
}

function flatFeePrice(overrides: Partial<PriceCard> = {}): PriceCard {
  return {
    productOfferingPriceId: "PRDOFP000002",
    name: "Monthly",
    componentType: "flat_fee",
    component: {
      "@type": "flat_fee",
      specVersion: 1,
      plaSpecId: null,
      priceType: "recurring",
      appliesAt: "billing",
      basis: "flat",
      boundTo: null,
      params: { amount: "100.00" },
    },
    currency: "MYR",
    unitOfMeasure: null,
    recurringChargePeriodLength: 1,
    recurringChargePeriodType: "months",
    glCode: "GL-4100",
    policy: null,
    startDateTime: new Date(2026, 6, 23),
    createdAt: new Date(2026, 6, 23),
    endDateTime: null,
    effectivityStatus: "current",
    ...overrides,
  };
}

function renderPanel(canEdit: boolean, prices: PriceCard[]): void {
  render(
    <ManagePricesPanel
      canEdit={canEdit}
      offeringId={OFFERING_ID}
      offeringName="Fibre 100"
      prices={prices}
      locale={LOCALE}
      timezone={TIMEZONE}
      familyId={FAMILY_ID}
      query=""
      status={null}
      page={1}
    />,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW);
  mockRefresh.mockReset();
  mockPush.mockReset();
  mockInsert.mockReset();
  mockUpdate.mockReset();
  mockDelete.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ManagePricesPanel / EditablePrices — authoring", () => {
  it("edit → save sends the edited amount to updatePriceAction and refreshes", async () => {
    mockUpdate.mockResolvedValue({
      ok: true,
      offeringId: OFFERING_ID,
      productOfferingPriceId: "PRDOFP000002",
      backdated: false,
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPanel(true, [flatFeePrice()]);

    await user.click(screen.getByRole("button", { name: /^Edit Monthly/ }));
    const amount = screen.getByLabelText("Amount");
    await user.clear(amount);
    await user.type(amount, "150.00");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith(
        "PRDOFP000002",
        expect.objectContaining({
          name: "Monthly",
          componentType: "flat_fee",
          params: { amount: "150.00" },
        }),
      );
    });
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("a VALIDATION_ERROR keeps the row in edit mode with the field message", async () => {
    mockUpdate.mockResolvedValue({
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: { name: ["Name is not allowed here"] },
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPanel(true, [flatFeePrice()]);

    await user.click(screen.getByRole("button", { name: /^Edit Monthly/ }));
    await user.clear(screen.getByLabelText("Amount"));
    await user.type(screen.getByLabelText("Amount"), "150.00");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByText("Name is not allowed here")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Amount")).toBeInTheDocument();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("DUPLICATE_START renders as a field error on the start date", async () => {
    mockUpdate.mockResolvedValue({ ok: false, code: "DUPLICATE_START" });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPanel(true, [flatFeePrice()]);

    await user.click(screen.getByRole("button", { name: /^Edit Monthly/ }));
    await user.clear(screen.getByLabelText("Amount"));
    await user.type(screen.getByLabelText("Amount"), "150.00");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByLabelText("Start date")).toHaveAttribute(
        "aria-invalid",
        "true",
      );
    });
    expect(
      screen.getByText(/already starts on that date/i),
    ).toBeInTheDocument();
  });

  it("delete confirms inline, calls deletePriceAction and refreshes", async () => {
    mockDelete.mockResolvedValue({
      ok: true,
      offeringId: OFFERING_ID,
      productOfferingPriceId: "PRDOFP000002",
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPanel(true, [flatFeePrice()]);

    await user.click(screen.getByRole("button", { name: /^Delete Monthly/ }));
    expect(screen.getByText("Delete this price?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith("PRDOFP000002");
    });
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("add: the add form calls insertPriceAction with a usage_rate payload", async () => {
    mockInsert.mockResolvedValue({
      ok: true,
      offeringId: OFFERING_ID,
      productOfferingPriceId: "PRDOFP000003",
      branched: false,
      backdated: false,
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPanel(true, []);

    await user.click(screen.getByRole("button", { name: "Add price" }));
    await user.type(screen.getByLabelText("Price name"), "Base usage rate");
    await user.type(screen.getByLabelText("Currency"), "MYR");
    await user.selectOptions(screen.getByLabelText("Unit of measure"), "EA");
    await user.type(screen.getByLabelText("Rate per unit"), "0.05");
    fireEvent.change(screen.getByLabelText("Start date"), {
      target: { value: "2026-07-24" },
    });
    await user.click(screen.getByRole("button", { name: "Add price" }));

    await waitFor(() => {
      expect(mockInsert).toHaveBeenCalledWith(
        OFFERING_ID,
        expect.objectContaining({
          name: "Base usage rate",
          componentType: "usage_rate",
        }),
      );
    });
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("only one row is editable at a time", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPanel(true, [
      usageRatePrice({
        productOfferingPriceId: "PRDOFP000001",
        name: "Price A",
      }),
      flatFeePrice({ productOfferingPriceId: "PRDOFP000002", name: "Price B" }),
    ]);

    await user.click(screen.getByRole("button", { name: /^Edit Price A/ }));
    expect(screen.getByLabelText("Price name")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Edit Price B/ }));

    expect(
      screen.getByRole("button", { name: /^Edit Price A/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Edit Price B/ }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByLabelText("Price name")).toHaveLength(1);
  });

  it("a mid-edit ACTIVE race on add that branches navigates to the new draft", async () => {
    mockInsert.mockResolvedValue({
      ok: true,
      offeringId: "PRDOFR000009",
      productOfferingPriceId: "PRDOFP000003",
      branched: true,
      backdated: false,
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPanel(true, []);

    await user.click(screen.getByRole("button", { name: "Add price" }));
    await user.type(screen.getByLabelText("Price name"), "Base usage rate");
    await user.type(screen.getByLabelText("Currency"), "MYR");
    await user.selectOptions(screen.getByLabelText("Unit of measure"), "EA");
    await user.type(screen.getByLabelText("Rate per unit"), "0.05");
    fireEvent.change(screen.getByLabelText("Start date"), {
      target: { value: "2026-07-24" },
    });
    await user.click(screen.getByRole("button", { name: "Add price" }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith(
        expect.stringContaining("version=PRDOFR000009"),
      );
    });
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("renders no editing controls when canEdit is false", () => {
    renderPanel(false, [flatFeePrice()]);

    expect(screen.getByText("Monthly")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add price" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Edit Monthly/ }),
    ).not.toBeInTheDocument();
  });
});

describe("ManagePricesPanel / EditablePrices — the offering-level banner (D4)", () => {
  it("CURRENCY_MISMATCH raises the banner naming both currencies and disables Save", async () => {
    mockInsert.mockResolvedValue({
      ok: false,
      code: "CURRENCY_MISMATCH",
      existingCurrency: "MYR",
      candidateCurrency: "USD",
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPanel(true, [flatFeePrice()]);

    await user.click(screen.getByRole("button", { name: "Add price" }));
    await user.type(screen.getByLabelText("Price name"), "Setup fee");
    await user.type(screen.getByLabelText("Currency"), "USD");
    await user.click(screen.getByRole("radio", { name: "Flat fee" }));
    await user.click(screen.getByRole("radio", { name: "One-time charge" }));
    await user.type(screen.getByLabelText("Amount"), "50.00");
    fireEvent.change(screen.getByLabelText("Start date"), {
      target: { value: "2026-07-24" },
    });
    await user.click(screen.getByRole("button", { name: "Add price" }));

    await waitFor(() => {
      expect(
        screen.getByText(
          "This offering's components are priced in MYR. USD cannot be mixed in.",
        ),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Add price" })).toBeDisabled();
  });

  it("MODIFIER_WITHOUT_BASE_RATE (via a capacity_commitment payload) raises the banner and disables Save", async () => {
    mockInsert.mockResolvedValue({
      ok: false,
      code: "MODIFIER_WITHOUT_BASE_RATE",
      unitOfMeasure: "EA",
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPanel(true, []);

    await user.click(screen.getByRole("button", { name: "Add price" }));
    await user.type(screen.getByLabelText("Price name"), "Commitment");
    await user.type(screen.getByLabelText("Currency"), "MYR");
    await user.click(
      screen.getByRole("radio", { name: "Target capacity commitment" }),
    );
    await user.selectOptions(screen.getByLabelText("Unit of measure"), "EA");
    await user.type(screen.getByLabelText("Committed quantity"), "1000");
    fireEvent.change(screen.getByLabelText("Start date"), {
      target: { value: "2026-07-24" },
    });
    await user.click(screen.getByRole("button", { name: "Add price" }));

    await waitFor(() => {
      expect(
        screen.getByText(
          "Target capacity commitment needs a base usage rate in EA. Add one before saving.",
        ),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Add price" })).toBeDisabled();
  });

  it("does not appear until the action returns, and a client-side field edit alone never raises it", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPanel(true, []);

    await user.click(screen.getByRole("button", { name: "Add price" }));
    await user.type(screen.getByLabelText("Price name"), "Commitment");
    await user.click(
      screen.getByRole("radio", { name: "Target capacity commitment" }),
    );
    await user.selectOptions(screen.getByLabelText("Unit of measure"), "EA");

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("clears once the user edits the form again, re-enabling Save", async () => {
    mockInsert.mockResolvedValue({
      ok: false,
      code: "CURRENCY_MISMATCH",
      existingCurrency: "MYR",
      candidateCurrency: "USD",
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPanel(true, [flatFeePrice()]);

    await user.click(screen.getByRole("button", { name: "Add price" }));
    await user.type(screen.getByLabelText("Price name"), "Setup fee");
    await user.type(screen.getByLabelText("Currency"), "USD");
    await user.click(screen.getByRole("radio", { name: "Flat fee" }));
    await user.click(screen.getByRole("radio", { name: "One-time charge" }));
    await user.type(screen.getByLabelText("Amount"), "50.00");
    fireEvent.change(screen.getByLabelText("Start date"), {
      target: { value: "2026-07-24" },
    });
    await user.click(screen.getByRole("button", { name: "Add price" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add price" })).toBeDisabled(),
    );

    await user.clear(screen.getByLabelText("Currency"));
    await user.type(screen.getByLabelText("Currency"), "MYR");

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Add price" }),
      ).not.toBeDisabled(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("ManagePricesPanel / EditablePrices — panel behaviour", () => {
  it("a non-DRAFT version renders read-only with no editing controls (canEdit=false)", () => {
    renderPanel(false, [usageRatePrice()]);
    expect(screen.getByText("Base usage rate")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
  });

  it("the not-yet-billable warnings render inline and never block", () => {
    renderPanel(true, [
      usageRatePrice({
        productOfferingPriceId: "PRDOFP000010",
        component: {
          "@type": "usage_rate",
          specVersion: 1,
          plaSpecId: "PLA_USAGE_RATE",
          priceType: "usage",
          appliesAt: "rating",
          basis: "quantity",
          boundTo: { unitOfMeasure: "EA" },
          params: { ratePerUnit: "100", rateCardLookUp: "ENTERPRISE_CARD" },
        },
      }),
    ]);

    expect(
      screen.getByText(
        "No rate card exists yet — ENTERPRISE_CARD falls back to the rate per unit.",
      ),
    ).toBeInTheDocument();
  });
});
