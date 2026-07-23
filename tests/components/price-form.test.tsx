import { fireEvent, render, screen } from "@testing-library/react";
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

async function fillRequiredFlatFields(
  user: ReturnType<typeof userEvent.setup>,
) {
  await user.type(screen.getByLabelText("Price name"), "Monthly recurring");
  await user.type(screen.getByLabelText("Currency"), "USD");
  await user.type(screen.getByLabelText("Amount"), "50.00");
}

function setStartDate(dateString: string) {
  fireEvent.change(screen.getByLabelText("Start date"), {
    target: { value: dateString },
  });
}

function submitForm() {
  const form = document.getElementById("price-form-add") as HTMLFormElement;
  fireEvent.submit(form);
}

describe("PriceForm", () => {
  it("shows the Amount field in flat mode and the tier editor in tiered mode, never both", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderForm();

    expect(screen.getByLabelText("Amount")).toBeInTheDocument();
    expect(screen.queryByText("Tiers")).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Tiered" }));

    expect(screen.queryByLabelText("Amount")).not.toBeInTheDocument();
    expect(screen.getByText("Tiers")).toBeInTheDocument();
  });

  it("'Add tier' appends a row and 'Remove' removes one, disabled when exactly one row remains", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderForm();
    await user.click(screen.getByRole("radio", { name: "Tiered" }));

    expect(screen.getAllByLabelText("From")).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Remove tier 1" }),
    ).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Add tier" }));

    expect(screen.getAllByLabelText("From")).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Remove tier 1" }),
    ).not.toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Remove tier 2" }),
    ).not.toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Remove tier 2" }));

    expect(screen.getAllByLabelText("From")).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Remove tier 1" }),
    ).toBeDisabled();
  });

  it("a start date more than 3 days in the past blocks submission with a field error", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onSubmit } = renderForm();
    await fillRequiredFlatFields(user);
    setStartDate(FOUR_DAYS_AGO);

    // zodResolver's default mode validates on submit, not on change.
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
    await fillRequiredFlatFields(user);
    setStartDate(THREE_DAYS_AGO);

    expect(
      await screen.findByText(
        `This price is backdated to ${THREE_DAYS_AGO}; historical bills may be affected.`,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Start date cannot be more than 3 days in the past."),
    ).not.toBeInTheDocument();

    submitForm();

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
  });

  it("a future or today's start date shows neither the warning nor an error", () => {
    renderForm();
    setStartDate(TODAY);

    expect(
      screen.queryByText(/historical bills may be affected/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Start date cannot be more than 3 days in the past."),
    ).not.toBeInTheDocument();

    setStartDate(TOMORROW);

    expect(
      screen.queryByText(/historical bills may be affected/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Start date cannot be more than 3 days in the past."),
    ).not.toBeInTheDocument();
  });

  it("submits a valid flat-priced form with the correctly assembled InsertPriceInput", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onSubmit } = renderForm();
    await fillRequiredFlatFields(user);
    setStartDate(TOMORROW);

    submitForm();

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const submitted = onSubmit.mock.calls[0]![0];
    expect(submitted.name).toBe("Monthly recurring");
    expect(submitted.currency).toBe("USD");
    expect(submitted.priceCharacteristics).toEqual({
      pricing_model: "flat",
      amount: "50.00",
      pricing_characteristics: null,
    });
  });

  it("submits a valid tiered-priced form with tiers coerced to numbers and an open-ended last tier", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onSubmit } = renderForm();
    await user.type(screen.getByLabelText("Price name"), "Usage tiers");
    await user.type(screen.getByLabelText("Currency"), "USD");
    await user.click(screen.getByRole("radio", { name: "Tiered" }));
    setStartDate(TOMORROW);

    await user.type(screen.getAllByLabelText("From")[0]!, "0");
    await user.type(screen.getAllByLabelText("To")[0]!, "100");
    await user.type(screen.getAllByLabelText("Rate")[0]!, "1.50");

    submitForm();

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const submitted = onSubmit.mock.calls[0]![0];
    expect(submitted.priceCharacteristics).toEqual({
      pricing_model: "tiered",
      amount: null,
      pricing_characteristics: {
        tiers: [{ from: 0, to: 100, rate: "1.50" }],
      },
    });
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
