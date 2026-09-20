import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// pm41 I6 (+ review fixes). ManagePricesPanel stays a server component; its
// editable client leaf (EditablePrices) is exercised here with the three price
// actions + next/navigation + sonner mocked. Fake timers pin "now" so the
// reused PriceForm's backdating logic is deterministic.
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

function makePrice(overrides: Partial<PriceCard>): PriceCard {
  return {
    productOfferingPriceId: "PRDOFP000001",
    name: "Monthly",
    priceType: "recurring",
    pricingModel: "flat",
    amount: "100.00",
    currency: "MYR",
    recurringChargePeriodLength: 1,
    recurringChargePeriodType: "months",
    unitOfMeasure: null,
    glCode: "GL-4100",
    policy: null,
    pricingCharacteristics: null,
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

describe("ManagePricesPanel", () => {
  it("edit → save sends the edited amount to updatePriceAction and refreshes", async () => {
    mockUpdate.mockResolvedValue({
      ok: true,
      offeringId: OFFERING_ID,
      productOfferingPriceId: "PRDOFP000001",
      backdated: false,
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPanel(true, [makePrice({ name: "Monthly" })]);

    await user.click(screen.getByRole("button", { name: /^Edit Monthly/ }));
    const amount = screen.getByLabelText("Amount");
    await user.clear(amount);
    await user.type(amount, "150.00");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith(
        "PRDOFP000001",
        expect.objectContaining({
          name: "Monthly",
          priceCharacteristics: expect.objectContaining({ amount: "150.00" }),
        }),
      );
    });
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("preserves a non-midnight stored start on an amount-only edit (review #3)", async () => {
    mockUpdate.mockResolvedValue({
      ok: true,
      offeringId: OFFERING_ID,
      productOfferingPriceId: "PRDOFP000001",
      backdated: false,
    });
    // A stored start with a time-of-day component, >3 days before "now".
    const start = new Date(2026, 6, 10, 9, 30, 0);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPanel(true, [makePrice({ name: "Monthly", startDateTime: start })]);

    await user.click(screen.getByRole("button", { name: /^Edit Monthly/ }));
    await user.clear(screen.getByLabelText("Amount"));
    await user.type(screen.getByLabelText("Amount"), "150.00");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith(
        "PRDOFP000001",
        expect.objectContaining({
          // The exact original instant is round-tripped — not flattened to
          // local midnight — so the service reads it as unchanged (no backdating,
          // no silent time-shift).
          startDateTime: start,
          priceCharacteristics: expect.objectContaining({ amount: "150.00" }),
        }),
      );
    });
  });

  it("a VALIDATION_ERROR keeps the row in edit mode with the field message", async () => {
    mockUpdate.mockResolvedValue({
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: { amount: ["Amount is not allowed here"] },
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPanel(true, [makePrice({ name: "Monthly" })]);

    await user.click(screen.getByRole("button", { name: /^Edit Monthly/ }));
    await user.clear(screen.getByLabelText("Amount"));
    await user.type(screen.getByLabelText("Amount"), "150.00");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(
        screen.getByText("Amount is not allowed here"),
      ).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Amount")).toBeInTheDocument();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("DUPLICATE_START renders as a field error on the start date (review #7)", async () => {
    mockUpdate.mockResolvedValue({ ok: false, code: "DUPLICATE_START" });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPanel(true, [makePrice({ name: "Monthly" })]);

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
      productOfferingPriceId: "PRDOFP000001",
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPanel(true, [makePrice({ name: "Monthly" })]);

    await user.click(screen.getByRole("button", { name: /^Delete Monthly/ }));
    expect(screen.getByText("Delete this price?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith("PRDOFP000001");
    });
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("add appends: the add form calls insertPriceAction", async () => {
    mockInsert.mockResolvedValue({
      ok: true,
      offeringId: OFFERING_ID,
      productOfferingPriceId: "PRDOFP000002",
      branched: false,
      backdated: false,
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPanel(true, []);

    await user.click(screen.getByRole("button", { name: "Add price" }));
    await user.type(screen.getByLabelText("Price name"), "Setup fee");
    await user.type(screen.getByLabelText("Currency"), "MYR");
    await user.type(screen.getByLabelText("Amount"), "50.00");
    fireEvent.change(screen.getByLabelText("Start date"), {
      target: { value: "2026-07-24" },
    });
    await user.click(screen.getByRole("button", { name: "Add price" }));

    await waitFor(() => {
      expect(mockInsert).toHaveBeenCalledWith(
        OFFERING_ID,
        expect.objectContaining({ name: "Setup fee" }),
      );
    });
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("only one row is editable at a time", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPanel(true, [
      makePrice({ productOfferingPriceId: "PRDOFP000001", name: "Price A" }),
      makePrice({ productOfferingPriceId: "PRDOFP000002", name: "Price B" }),
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

  it("activating a second row while the first is dirty prompts to discard (review #4/#5)", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPanel(true, [
      makePrice({ productOfferingPriceId: "PRDOFP000001", name: "Price A" }),
      makePrice({ productOfferingPriceId: "PRDOFP000002", name: "Price B" }),
    ]);

    await user.click(screen.getByRole("button", { name: /^Edit Price A/ }));
    await user.clear(screen.getByLabelText("Amount"));
    await user.type(screen.getByLabelText("Amount"), "999.00"); // dirty
    await user.click(screen.getByRole("button", { name: /^Edit Price B/ }));

    expect(
      screen.getByText("Discard unsaved changes to this price?"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(
      screen.queryByText("Discard unsaved changes to this price?"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Edit Price B/ }));
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(
      screen.getByRole("button", { name: /^Edit Price A/ }),
    ).toBeInTheDocument();
  });

  it("a mid-edit ACTIVE race on add that branches navigates to the new draft (review #2)", async () => {
    mockInsert.mockResolvedValue({
      ok: true,
      offeringId: "PRDOFR000009",
      productOfferingPriceId: "PRDOFP000002",
      branched: true,
      backdated: false,
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPanel(true, []);

    await user.click(screen.getByRole("button", { name: "Add price" }));
    await user.type(screen.getByLabelText("Price name"), "Setup fee");
    await user.type(screen.getByLabelText("Currency"), "MYR");
    await user.type(screen.getByLabelText("Amount"), "50.00");
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
    renderPanel(false, [makePrice({ name: "Monthly" })]);

    expect(screen.getByText("Monthly")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add price" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Edit Monthly/ }),
    ).not.toBeInTheDocument();
  });
});
