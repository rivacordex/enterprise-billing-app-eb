import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PricesPanel } from "@/components/products/prices-panel";
import type { PriceCard } from "@/types/product";

const LOCALE = "en-MY";
const TIMEZONE = "UTC";

function usageRatePrice(overrides: Partial<PriceCard> = {}): PriceCard {
  return {
    productOfferingPriceId: "PRDOFP000001",
    name: "Base Usage Rate",
    componentType: "usage_rate",
    component: {
      "@type": "usage_rate",
      specVersion: 1,
      plaSpecId: "PLA_USAGE_RATE",
      priceType: "usage",
      appliesAt: "rating",
      basis: "quantity",
      boundTo: { unitOfMeasure: "EA" },
      params: { ratePerUnit: "100", rateCardLookUp: "ENTERPRISE_EA_CARD" },
    },
    currency: "MYR",
    unitOfMeasure: "EA",
    recurringChargePeriodLength: null,
    recurringChargePeriodType: null,
    glCode: null,
    policy: null,
    startDateTime: new Date("2026-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    endDateTime: null,
    effectivityStatus: "current",
    ...overrides,
  };
}

function flatFeePrice(overrides: Partial<PriceCard> = {}): PriceCard {
  return {
    productOfferingPriceId: "PRDOFP000002",
    name: "Monthly Recurring Charge",
    componentType: "flat_fee",
    component: {
      "@type": "flat_fee",
      specVersion: 1,
      plaSpecId: null,
      priceType: "recurring",
      appliesAt: "billing",
      basis: "flat",
      boundTo: null,
      params: { amount: "2000.00" },
    },
    currency: "MYR",
    unitOfMeasure: null,
    recurringChargePeriodLength: 1,
    recurringChargePeriodType: "months",
    glCode: "GL-4100",
    policy: null,
    startDateTime: new Date("2026-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    endDateTime: new Date("2027-01-01T00:00:00.000Z"),
    effectivityStatus: "current",
    ...overrides,
  };
}

function capacityCommitmentPrice(
  overrides: Partial<PriceCard> = {},
): PriceCard {
  return {
    productOfferingPriceId: "PRDOFP000003",
    name: "Target Capacity Commitment",
    componentType: "capacity_commitment",
    component: {
      "@type": "capacity_commitment",
      specVersion: 1,
      plaSpecId: "PLA_CAPACITY_COMMITMENT",
      priceType: "commitment",
      appliesAt: "post_aggregation",
      basis: "quantity",
      boundTo: { unitOfMeasure: "EA" },
      params: { committedQuantity: 1000 },
    },
    currency: "MYR",
    unitOfMeasure: "EA",
    recurringChargePeriodLength: null,
    recurringChargePeriodType: null,
    glCode: null,
    policy: null,
    startDateTime: new Date("2026-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    endDateTime: null,
    effectivityStatus: "current",
    ...overrides,
  };
}

function capacityMotivationPrice(
  overrides: Partial<PriceCard> = {},
): PriceCard {
  return {
    productOfferingPriceId: "PRDOFP000004",
    name: "Target Capacity Motivation",
    componentType: "capacity_motivation",
    component: {
      "@type": "capacity_motivation",
      specVersion: 1,
      plaSpecId: "PLA_CAPACITY_MOTIVATION",
      priceType: "discount",
      appliesAt: "post_aggregation",
      basis: "quantity",
      boundTo: { unitOfMeasure: "EA" },
      params: {
        steps: [
          { aboveQuantity: 1000, ratePerUnit: "50" },
          { aboveQuantity: 2000, ratePerUnit: "25" },
        ],
      },
    },
    currency: "MYR",
    unitOfMeasure: "EA",
    recurringChargePeriodLength: null,
    recurringChargePeriodType: null,
    glCode: null,
    policy: null,
    startDateTime: new Date("2026-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    endDateTime: null,
    effectivityStatus: "current",
    ...overrides,
  };
}

// pm48's "Demo — Enterprise Capacity Plan" offering (pm53-spec I5.2): a
// usage_rate + capacity_commitment + capacity_motivation sharing the EA lane,
// plus a recurring flat_fee.
function demoOfferingPrices(): PriceCard[] {
  return [
    usageRatePrice(),
    capacityCommitmentPrice(),
    capacityMotivationPrice(),
    flatFeePrice(),
  ];
}

describe("PricesPanel", () => {
  it("renders the pm48 demo offering's four components with the spec's exact figures", () => {
    render(
      <PricesPanel
        prices={demoOfferingPrices()}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );

    expect(screen.getByText(/RM\s?100\.00/)).toBeInTheDocument();
    expect(screen.getByText(/\/ EA/)).toBeInTheDocument();
    expect(screen.getByText("committed 1,000 EA")).toBeInTheDocument();
    expect(
      screen.getByText("base 100; above 1000: 50; above 2000: 25"),
    ).toBeInTheDocument();
    expect(screen.getByText("ENTERPRISE_EA_CARD")).toBeInTheDocument();
    expect(screen.getByText(/RM\s?2,000\.00/)).toBeInTheDocument();
    expect(screen.getByText(/\/ 1 months/)).toBeInTheDocument();
  });

  it("shows no currency symbol anywhere in the capacity_commitment card", () => {
    render(
      <PricesPanel
        prices={[capacityCommitmentPrice()]}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );
    const card = screen.getByText("committed 1,000 EA").closest("div");
    expect(card?.textContent).not.toMatch(/RM|MYR/);
  });

  it("renders the correct badge label for each of the four demo components", () => {
    render(
      <PricesPanel
        prices={demoOfferingPrices()}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );
    expect(screen.getByText("Usage rate")).toBeInTheDocument();
    expect(screen.getByText("Target capacity commitment")).toBeInTheDocument();
    expect(screen.getByText("Target capacity motivation")).toBeInTheDocument();
    expect(screen.getByText("Recurring charge")).toBeInTheDocument();
  });

  it("renders a bare amount with no unit for a oneTime flat_fee", () => {
    render(
      <PricesPanel
        prices={[
          flatFeePrice({
            productOfferingPriceId: "PRDOFP000005",
            name: "Activation Fee",
            component: {
              "@type": "flat_fee",
              specVersion: 1,
              plaSpecId: null,
              priceType: "oneTime",
              appliesAt: "billing",
              basis: "flat",
              boundTo: null,
              params: { amount: "500.00" },
            },
            recurringChargePeriodLength: null,
            recurringChargePeriodType: null,
          }),
        ]}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );
    expect(screen.getByText("One-time charge")).toBeInTheDocument();
    expect(screen.getByText(/RM\s?500\.00/)).toBeInTheDocument();
    expect(screen.queryByText("Charge period")).not.toBeInTheDocument();
  });

  it('renders a null rate card as a muted "default rate" with no link, button or href', () => {
    const { container } = render(
      <PricesPanel
        prices={[
          usageRatePrice({
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
          }),
        ]}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );
    expect(screen.getByText("default rate")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(container.querySelector("[href]")).toBeNull();
  });

  it("computes effectivity per lane: a capacity_motivation does not supersede the usage_rate beside it", () => {
    render(
      <PricesPanel
        prices={[
          usageRatePrice({
            productOfferingPriceId: "PRDOFP000010",
            effectivityStatus: "superseded",
            // Distinct from the current sibling's "100" (below) so a wrong
            // pick by findBaseRate (e.g. array order rather than matching
            // effectivityStatus) is detectable in the motivation card's text.
            component: {
              "@type": "usage_rate",
              specVersion: 1,
              plaSpecId: "PLA_USAGE_RATE",
              priceType: "usage",
              appliesAt: "rating",
              basis: "quantity",
              boundTo: { unitOfMeasure: "EA" },
              params: {
                ratePerUnit: "999",
                rateCardLookUp: "ENTERPRISE_EA_CARD",
              },
            },
          }),
          usageRatePrice({
            productOfferingPriceId: "PRDOFP000011",
            effectivityStatus: "current",
            startDateTime: new Date("2026-08-01T00:00:00.000Z"),
          }),
          capacityMotivationPrice({
            productOfferingPriceId: "PRDOFP000012",
            effectivityStatus: "current",
          }),
        ]}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );

    const supersededCard = screen.getByText("PRDOFP000010").closest("div");
    const successorCard = screen.getByText("PRDOFP000011").closest("div");
    const motivationCard = screen.getByText("PRDOFP000012").closest("div");

    expect(supersededCard).toHaveClass("text-muted-foreground");
    expect(screen.getAllByText("Superseded")).toHaveLength(1);
    expect(successorCard).toHaveClass("border-l-[color:var(--color-cyan-500)]");
    expect(motivationCard).toHaveClass(
      "border-l-[color:var(--color-cyan-500)]",
    );
    expect(motivationCard?.textContent).not.toContain("Superseded");
    expect(motivationCard?.textContent).toContain("base 100");
    expect(motivationCard?.textContent).not.toContain("base 999");
  });

  it("renders nothing for a badge whose componentType disagrees with the envelope @type (D2 guard)", () => {
    render(
      <PricesPanel
        prices={[
          flatFeePrice({
            componentType: "flat_fee",
            component: {
              "@type": "flat_fee",
              specVersion: 1,
              plaSpecId: null,
              // @ts-expect-error -- deliberately corrupt for the D2 guard test
              priceType: "usage",
              appliesAt: "billing",
              basis: "flat",
              boundTo: null,
              params: { amount: "2000.00" },
            },
          }),
        ]}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );
    expect(screen.queryByText("Recurring charge")).not.toBeInTheDocument();
    expect(screen.queryByText("One-time charge")).not.toBeInTheDocument();
  });

  it("omits the badge entirely when componentType disagrees with the envelope @type", () => {
    render(
      <PricesPanel
        prices={[flatFeePrice({ componentType: "usage_rate" })]}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );
    expect(screen.queryByText("Recurring charge")).not.toBeInTheDocument();
    expect(screen.queryByText("One-time charge")).not.toBeInTheDocument();
    expect(screen.queryByText("Usage rate")).not.toBeInTheDocument();
  });

  it("never leaks a raw component_type/@type value or a derived envelope field into user-facing text", () => {
    const { container } = render(
      <PricesPanel
        prices={demoOfferingPrices()}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );
    const forbidden = [
      "usage_rate",
      "flat_fee",
      "capacity_commitment",
      "capacity_motivation",
      "specVersion",
      "plaSpecId",
      "appliesAt",
      "basis",
      "boundTo",
    ];
    const text = container.textContent ?? "";
    for (const value of forbidden) {
      expect(text).not.toContain(value);
    }
    for (const el of container.querySelectorAll("[title], [aria-label]")) {
      const title = el.getAttribute("title") ?? "";
      const ariaLabel = el.getAttribute("aria-label") ?? "";
      for (const value of forbidden) {
        expect(title).not.toContain(value);
        expect(ariaLabel).not.toContain(value);
      }
    }
  });

  it("shows the Charge period row only when recurringChargePeriodLength is non-null", () => {
    const { rerender } = render(
      <PricesPanel
        prices={[flatFeePrice()]}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );
    expect(screen.getByText("Charge period")).toBeInTheDocument();
    expect(screen.getByText("1 months")).toBeInTheDocument();

    rerender(
      <PricesPanel
        prices={[capacityCommitmentPrice()]}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );
    expect(screen.queryByText("Charge period")).not.toBeInTheDocument();
  });

  it("shows the Unit of measure row only when non-null", () => {
    const { rerender } = render(
      <PricesPanel
        prices={[usageRatePrice()]}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );
    expect(screen.getByText("Unit of measure")).toBeInTheDocument();
    expect(screen.getAllByText("EA").length).toBeGreaterThan(0);

    rerender(
      <PricesPanel
        prices={[flatFeePrice()]}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );
    expect(screen.queryByText("Unit of measure")).not.toBeInTheDocument();
  });

  it("shows the GL code row only when non-null", () => {
    const { rerender } = render(
      <PricesPanel
        prices={[flatFeePrice({ glCode: "GL-4100" })]}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );
    expect(screen.getByText("GL code")).toBeInTheDocument();
    expect(screen.getByText("GL-4100")).toBeInTheDocument();

    rerender(
      <PricesPanel
        prices={[flatFeePrice({ glCode: null })]}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );
    expect(screen.queryByText("GL code")).not.toBeInTheDocument();
  });

  it("shows the Policy row only when non-null", () => {
    const { rerender } = render(
      <PricesPanel
        prices={[flatFeePrice({ policy: "no-refund" })]}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );
    expect(screen.getByText("Policy")).toBeInTheDocument();
    expect(screen.getByText("no-refund")).toBeInTheDocument();

    rerender(
      <PricesPanel
        prices={[flatFeePrice({ policy: null })]}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );
    expect(screen.queryByText("Policy")).not.toBeInTheDocument();
  });

  it('shows a "Starts …" info tag for a future price', () => {
    render(
      <PricesPanel
        prices={[
          flatFeePrice({
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

  it("renders both start and end datetimes when endDateTime is non-null", () => {
    render(
      <PricesPanel
        prices={[
          flatFeePrice({
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
        prices={[flatFeePrice({ endDateTime: null })]}
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
