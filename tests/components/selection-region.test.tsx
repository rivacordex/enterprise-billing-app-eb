import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SelectionRegion } from "@/components/products/manage/selection-region";
import type {
  LifecycleStatus,
  OfferingDetail,
  PriceCard,
} from "@/types/product";

// pm40 I6/§1.19/§4.16. Locks SelectionRegion's states — especially the muted
// DRAFT-with-no-prices submit hint (which the page's orchestration test cannot
// see because it mocks this component to null). The composed View components
// (OfferingDetail/SpecificationsPanel/PricesPanel) render for real here.
const LOCALE = "en-US";
const TIMEZONE = "UTC";

function makePrice(): PriceCard {
  return {
    productOfferingPriceId: "PRDOFP000001",
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
    recurringChargePeriodLength: 1,
    recurringChargePeriodType: "months",
    unitOfMeasure: null,
    glCode: "GL-4100",
    policy: null,
    startDateTime: new Date("2026-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    endDateTime: null,
    effectivityStatus: "current",
  };
}

function makeOffering(
  lifecycleStatus: LifecycleStatus,
  prices: PriceCard[],
): OfferingDetail {
  return {
    productOfferingId: "PRDOFR000001",
    name: "Fibre 100",
    isBundle: false,
    isSellable: true,
    billingOnly: false,
    lifecycleStatus,
    version: 1,
    lastModified: new Date("2026-01-01T00:00:00.000Z"),
    lastEditedByName: "Admin",
    specifications: [],
    prices,
  };
}

const HINT =
  /at least one price is required before this version can be submitted for testing/i;

describe("SelectionRegion", () => {
  it("shows the select-a-product prompt when no family is selected", () => {
    render(
      <SelectionRegion
        hasFamily={false}
        offering={null}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );
    expect(
      screen.getByText(/select a product to see its versions/i),
    ).toBeInTheDocument();
  });

  it("shows the no-longer-exists line for a selected family that matches no row", () => {
    render(
      <SelectionRegion
        hasFamily={true}
        offering={null}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );
    expect(
      screen.getByText(/that product no longer exists/i),
    ).toBeInTheDocument();
  });

  it("shows the DRAFT no-price submit hint only for a DRAFT version with zero prices", () => {
    render(
      <SelectionRegion
        hasFamily={true}
        offering={makeOffering("DRAFT", [])}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );
    expect(screen.getByText(HINT)).toBeInTheDocument();
  });

  it("does not show the hint for a DRAFT version that already has prices", () => {
    render(
      <SelectionRegion
        hasFamily={true}
        offering={makeOffering("DRAFT", [makePrice()])}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });

  it("does not show the hint for a non-DRAFT version with no prices", () => {
    render(
      <SelectionRegion
        hasFamily={true}
        offering={makeOffering("ACTIVE", [])}
        locale={LOCALE}
        timezone={TIMEZONE}
      />,
    );
    // The version is not editable, so the "add a price to submit" hint must not
    // appear even though the price list is empty.
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
    expect(screen.getByText("Details")).toBeInTheDocument();
  });
});
