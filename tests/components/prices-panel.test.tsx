import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PricesPanel } from "@/components/products/prices-panel";
import type { PriceCard } from "@/types/product";

function makePrice(overrides: Partial<PriceCard> = {}): PriceCard {
  return {
    productOfferingPriceId: "PRDOFP000001",
    name: "Monthly Recurring Charge",
    priceType: "recurring",
    pricingModel: "flat",
    amount: "5000.00",
    currency: "MYR",
    recurringChargePeriodLength: 1,
    recurringChargePeriodType: "months",
    unitOfMeasure: null,
    glCode: "GL-4100",
    policy: null,
    pricingCharacteristics: null,
    startDateTime: new Date("2026-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    endDateTime: new Date("2027-01-01T00:00:00.000Z"),
    effectivityStatus: "current",
    ...overrides,
  };
}

const LOCALE = "en-US";
const TIMEZONE = "UTC";

describe("PricesPanel", () => {
  it("renders one card per price with its mono id eyebrow, name, and price-type badge", () => {
    render(
      <PricesPanel
        prices={[
          makePrice({ productOfferingPriceId: "PRDOFP000001" }),
          makePrice({
            productOfferingPriceId: "PRDOFP000002",
            name: "Activation Fee",
            priceType: "once",
          }),
        ]}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );

    expect(screen.getByText("PRDOFP000001")).toBeInTheDocument();
    expect(screen.getByText("PRDOFP000002")).toBeInTheDocument();
    expect(screen.getByText("Activation Fee")).toBeInTheDocument();
    expect(screen.getAllByText("Recurring")).toHaveLength(1);
    expect(screen.getByText("Once")).toBeInTheDocument();
  });

  it("shows the formatCurrency amount and currency code for a flat price, and no TierTable", () => {
    render(
      <PricesPanel
        prices={[makePrice({ amount: "5000.00", currency: "MYR" })]}
        locale="en-MY"
        timezone={TIMEZONE}
      />,
    );

    expect(screen.getByText("RM 5,000.00")).toBeInTheDocument();
    expect(screen.getByText("MYR")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows a TierTable and no flat-amount line for a tiered price, never the literal (tiered)", () => {
    render(
      <PricesPanel
        prices={[
          makePrice({
            name: "Data Overage",
            priceType: "usage",
            pricingModel: "tiered",
            amount: null,
            unitOfMeasure: "GB",
            pricingCharacteristics: {
              tiers: [
                { from: 0, to: 1000, rate: "0.05" },
                { from: 1000, to: null, rate: "0.03" },
              ],
            },
          }),
        ]}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("0.05")).toBeInTheDocument();
    expect(screen.getByText("and above")).toBeInTheDocument();
    expect(screen.queryByText("(tiered)")).not.toBeInTheDocument();
  });

  it("shows the Charge period row only when recurringChargePeriodLength is non-null", () => {
    const { rerender } = render(
      <PricesPanel
        prices={[
          makePrice({
            recurringChargePeriodLength: 1,
            recurringChargePeriodType: "months",
          }),
        ]}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );
    expect(screen.getByText("Charge period")).toBeInTheDocument();
    expect(screen.getByText("1 months")).toBeInTheDocument();

    rerender(
      <PricesPanel
        prices={[
          makePrice({
            recurringChargePeriodLength: null,
            recurringChargePeriodType: null,
          }),
        ]}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );
    expect(screen.queryByText("Charge period")).not.toBeInTheDocument();
  });

  it("shows the Unit of measure row only when non-null", () => {
    const { rerender } = render(
      <PricesPanel
        prices={[makePrice({ unitOfMeasure: "GB" })]}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );
    expect(screen.getByText("Unit of measure")).toBeInTheDocument();
    expect(screen.getByText("GB")).toBeInTheDocument();

    rerender(
      <PricesPanel
        prices={[makePrice({ unitOfMeasure: null })]}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );
    expect(screen.queryByText("Unit of measure")).not.toBeInTheDocument();
  });

  it("shows the GL code row only when non-null", () => {
    const { rerender } = render(
      <PricesPanel
        prices={[makePrice({ glCode: "GL-4100" })]}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );
    expect(screen.getByText("GL code")).toBeInTheDocument();
    expect(screen.getByText("GL-4100")).toBeInTheDocument();

    rerender(
      <PricesPanel
        prices={[makePrice({ glCode: null })]}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );
    expect(screen.queryByText("GL code")).not.toBeInTheDocument();
  });

  it("shows the Policy row only when non-null", () => {
    const { rerender } = render(
      <PricesPanel
        prices={[makePrice({ policy: "no-refund" })]}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );
    expect(screen.getByText("Policy")).toBeInTheDocument();
    expect(screen.getByText("no-refund")).toBeInTheDocument();

    rerender(
      <PricesPanel
        prices={[makePrice({ policy: null })]}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );
    expect(screen.queryByText("Policy")).not.toBeInTheDocument();
  });

  it("styles a current price with a cyan left border and no tag", () => {
    render(
      <PricesPanel
        prices={[makePrice({ effectivityStatus: "current" })]}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );
    const card = screen.getByText("PRDOFP000001").closest("div");
    expect(card).toHaveClass("border-l-[color:var(--color-cyan-500)]");
    expect(screen.queryByText(/Starts /)).not.toBeInTheDocument();
    expect(screen.queryByText("Superseded")).not.toBeInTheDocument();
  });

  it('shows a "Starts …" info tag for a future price', () => {
    render(
      <PricesPanel
        prices={[
          makePrice({
            effectivityStatus: "future",
            startDateTime: new Date("2027-01-01T00:00:00.000Z"),
          }),
        ]}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );
    expect(screen.getByText(/Starts /)).toBeInTheDocument();
  });

  it('mutes the card and shows a "Superseded" tag for a superseded price', () => {
    render(
      <PricesPanel
        prices={[makePrice({ effectivityStatus: "superseded" })]}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );
    expect(screen.getByText("Superseded")).toBeInTheDocument();
    const card = screen.getByText("PRDOFP000001").closest("div");
    expect(card).toHaveClass("text-muted-foreground");
  });

  it("styles multiple simultaneously-current prices as each current (no single-current assumption)", () => {
    render(
      <PricesPanel
        prices={[
          makePrice({
            productOfferingPriceId: "PRDOFP000001",
            priceType: "recurring",
            effectivityStatus: "current",
          }),
          makePrice({
            productOfferingPriceId: "PRDOFP000003",
            priceType: "usage",
            name: "Data Usage",
            effectivityStatus: "current",
          }),
        ]}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );

    const cardOne = screen.getByText("PRDOFP000001").closest("div");
    const cardTwo = screen.getByText("PRDOFP000003").closest("div");
    expect(cardOne).toHaveClass("border-l-[color:var(--color-cyan-500)]");
    expect(cardTwo).toHaveClass("border-l-[color:var(--color-cyan-500)]");
  });

  it("renders both start and end datetimes when endDateTime is non-null", () => {
    render(
      <PricesPanel
        prices={[
          makePrice({
            startDateTime: new Date("2026-01-01T00:00:00.000Z"),
            endDateTime: new Date("2027-01-01T00:00:00.000Z"),
            createdAt: new Date("2025-11-15T00:00:00.000Z"),
          }),
        ]}
        locale="en-GB"
        timezone={TIMEZONE}
      />,
    );

    expect(screen.getByText(/01 Jan 2026/)).toBeInTheDocument();
    expect(screen.getByText(/01 Jan 2027/)).toBeInTheDocument();
  });

  it('renders "Open-ended" (not "Never") when endDateTime is null', () => {
    render(
      <PricesPanel
        prices={[makePrice({ endDateTime: null })]}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );

    expect(screen.getByText(/Open-ended/)).toBeInTheDocument();
    expect(screen.queryByText(/Never/)).not.toBeInTheDocument();
  });

  it("renders the empty state when prices is empty", () => {
    render(<PricesPanel prices={[]} locale={LOCALE} timezone={TIMEZONE} />);

    expect(
      screen.getByText("No prices for this offering."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
