import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PriceForm } from "@/components/products/manage/price-form";
import type { InsertPriceInput } from "@/validation/product/insert-price.schema";

// Fixed local "now" at midnight so the 3-day backdating boundary is
// deterministic regardless of the real wall-clock time-of-day (Design §2.5 —
// the banner/error are computed from `Date.now()` vs. the selected date's
// own local midnight). Only Date is faked, not timers, so userEvent's
// internal delays still work normally.
const FIXED_NOW = new Date(2026, 6, 23, 0, 0, 0);
const TODAY = "2026-07-23";
const TOMORROW = "2026-07-24";
const THREE_DAYS_AGO = "2026-07-20";
const FOUR_DAYS_AGO = "2026-07-19";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function renderForm(
  overrides: Partial<{
    currentStatus: "DRAFT" | "ACTIVE";
    isSubmitting: boolean;
  }> = {},
) {
  const onSubmit = vi.fn<(values: InsertPriceInput) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const result = render(
    <PriceForm
      offeringName="Test Plan"
      currentStatus={overrides.currentStatus ?? "DRAFT"}
      onSubmit={onSubmit}
      isSubmitting={overrides.isSubmitting ?? false}
    />,
  );
  return { onSubmit, ...result };
}

async function fillUsageRateFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Price name"), "Base usage rate");
  await user.type(screen.getByLabelText("Currency"), "USD");
  await user.click(screen.getByRole("radio", { name: "Usage rate" }));
  await user.selectOptions(screen.getByLabelText("Unit of measure"), "EA");
  await user.type(screen.getByLabelText("Rate per unit"), "0.05");
}

function setStartDate(dateString: string) {
  act(() => {
    fireEvent.change(screen.getByLabelText("Start date"), {
      target: { value: dateString },
    });
  });
}

function submitForm() {
  act(() => {
    const form = document.getElementById("price-form-add") as HTMLFormElement;
    fireEvent.submit(form);
  });
}

describe("PriceForm — component picker (D1)", () => {
  it("defaults to Usage rate and offers exactly the four persistable types, never negotiated_override", () => {
    renderForm();

    expect(screen.getByRole("radio", { name: "Usage rate" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Flat fee" })).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "Target capacity commitment" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "Target capacity motivation" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    expect(screen.queryByText(/negotiated/i)).not.toBeInTheDocument();
  });

  it("usage_rate shows the unit and hides the recurring period pair", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderForm();
    await user.click(screen.getByRole("radio", { name: "Usage rate" }));

    expect(screen.getByLabelText("Unit of measure")).toBeInTheDocument();
    expect(screen.getByLabelText("Rate per unit")).toBeInTheDocument();
    expect(screen.queryByLabelText("Charge period")).not.toBeInTheDocument();
  });

  it("flat_fee hides the unit and only shows the period pair when recurring", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderForm();
    await user.click(screen.getByRole("radio", { name: "Flat fee" }));

    expect(screen.queryByLabelText("Unit of measure")).not.toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "Recurring charge" }),
    ).toBeChecked();
    expect(screen.getByLabelText("Charge period")).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "One-time charge" }));
    expect(screen.queryByLabelText("Charge period")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Unit of measure")).not.toBeInTheDocument();
  });

  it("capacity_commitment shows the unit and a committed quantity field with no currency inside the branch", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderForm();
    await user.click(
      screen.getByRole("radio", { name: "Target capacity commitment" }),
    );

    expect(screen.getByLabelText("Unit of measure")).toBeInTheDocument();
    expect(screen.getByLabelText("Committed quantity")).toBeInTheDocument();
    // Currency lives above the picker (D1) and is not duplicated in the branch.
    expect(screen.getAllByLabelText("Currency")).toHaveLength(1);
  });

  it("switching component type resets the previous branch's fields (nothing rendered disabled instead of hidden)", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderForm();
    await user.click(screen.getByRole("radio", { name: "Usage rate" }));
    await user.type(screen.getByLabelText("Rate per unit"), "0.05");

    await user.click(screen.getByRole("radio", { name: "Flat fee" }));
    expect(screen.queryByLabelText("Rate per unit")).not.toBeInTheDocument();
  });
});

describe("PriceForm — rateCardLookUp (D3)", () => {
  it("is free text, optional, mono, with no autocomplete and issues no network request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderForm();
    await user.click(screen.getByRole("radio", { name: "Usage rate" }));

    const input = screen.getByLabelText("Rate card name");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input.className).toContain("font-mono");
    await user.type(input, "ENTERPRISE_EA_CARD");
    expect(input).toHaveValue("ENTERPRISE_EA_CARD");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("PriceForm — backdating (unchanged from pm41)", () => {
  it("a start date more than 3 days in the past blocks submission with a field error", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onSubmit } = renderForm();
    await fillUsageRateFields(user);
    setStartDate(FOUR_DAYS_AGO);

    submitForm();

    expect(
      await screen.findByText(
        "Start date cannot be more than 3 days in the past.",
      ),
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("a start date exactly 3 days in the past does not block and shows the non-blocking backdating warning", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onSubmit } = renderForm();
    await fillUsageRateFields(user);
    setStartDate(THREE_DAYS_AGO);

    expect(
      await screen.findByText(
        `This price is backdated to ${THREE_DAYS_AGO}; historical bills may be affected.`,
      ),
    ).toBeInTheDocument();

    submitForm();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  });

  it("a future or today's start date shows neither the warning nor an error", () => {
    renderForm();
    setStartDate(TODAY);
    expect(
      screen.queryByText(/historical bills may be affected/),
    ).not.toBeInTheDocument();
    setStartDate(TOMORROW);
    expect(
      screen.queryByText(/historical bills may be affected/),
    ).not.toBeInTheDocument();
  });
});

describe("PriceForm — submission assembly", () => {
  it("submits a usage_rate InsertPriceInput with the correct branch shape", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onSubmit } = renderForm();
    await fillUsageRateFields(user);
    setStartDate(TOMORROW);

    submitForm();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const submitted = onSubmit.mock.calls[0]![0];
    expect(submitted.componentType).toBe("usage_rate");
    expect(submitted.name).toBe("Base usage rate");
    expect(submitted.currency).toBe("USD");
    if (submitted.componentType === "usage_rate") {
      expect(submitted.unitOfMeasure).toBe("EA");
      expect(submitted.params).toEqual({
        ratePerUnit: "0.05",
        rateCardLookUp: null,
      });
    }
  });

  it("submits a recurring flat_fee InsertPriceInput with the charge period", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onSubmit } = renderForm();
    await user.type(screen.getByLabelText("Price name"), "Monthly recurring");
    await user.type(screen.getByLabelText("Currency"), "USD");
    await user.click(screen.getByRole("radio", { name: "Flat fee" }));
    await user.type(screen.getByLabelText("Amount"), "2000.00");
    setStartDate(TOMORROW);

    submitForm();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const submitted = onSubmit.mock.calls[0]![0];
    expect(submitted.componentType).toBe("flat_fee");
    if (
      submitted.componentType === "flat_fee" &&
      submitted.priceType === "recurring"
    ) {
      expect(submitted.recurringChargePeriodLength).toBe(1);
      expect(submitted.recurringChargePeriodType).toBe("months");
      expect(submitted.params).toEqual({ amount: "2000.00" });
    } else {
      throw new Error("expected recurring flat_fee");
    }
  });

  it("submits a oneTime flat_fee InsertPriceInput with no period fields", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onSubmit } = renderForm();
    await user.type(screen.getByLabelText("Price name"), "Activation fee");
    await user.type(screen.getByLabelText("Currency"), "USD");
    await user.click(screen.getByRole("radio", { name: "Flat fee" }));
    await user.click(screen.getByRole("radio", { name: "One-time charge" }));
    await user.type(screen.getByLabelText("Amount"), "500.00");
    setStartDate(TOMORROW);

    submitForm();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const submitted = onSubmit.mock.calls[0]![0];
    expect(submitted).toMatchObject({
      componentType: "flat_fee",
      priceType: "oneTime",
      params: { amount: "500.00" },
    });
    expect(submitted).not.toHaveProperty("recurringChargePeriodLength");
  });

  it("shows the --bg-warning banner only when currentStatus is ACTIVE", () => {
    const { unmount } = renderForm({ currentStatus: "DRAFT" });
    expect(screen.queryByText(/is active\. Saving will not/)).toBeNull();
    unmount();

    renderForm({ currentStatus: "ACTIVE" });
    expect(
      screen.getByText(
        "Test Plan is active. Saving will not change it — a new draft version is created instead.",
      ),
    ).toBeInTheDocument();
  });
});
