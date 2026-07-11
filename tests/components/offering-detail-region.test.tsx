import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OfferingDetailRegion } from "@/components/products/offering-detail-region";
import type { OfferingDetail } from "@/types/product";

const FIXTURE_OFFERING: OfferingDetail = {
  productOfferingId: "PRDOFR000001",
  name: "5G Nationwide Service Plan",
  isBundle: false,
  isSellable: true,
  billingOnly: false,
  lifecycleStatus: "ACTIVE",
  version: 3,
  lastModified: new Date("2026-07-03T14:22:00.000Z"),
  lastEditedByName: "Jordan Rivera",
  specifications: [
    {
      productSpecId: "PRDSMD000001",
      name: "Network Slice eMBB",
      isMandatory: true,
      isDefault: true,
      defaultValue: null,
      characteristics: { SST_ID: "01", SD_ID: "A0C4E2" },
    },
  ],
  prices: [
    {
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
    },
  ],
};

describe("OfferingDetailRegion", () => {
  it('renders the "Select an offering" empty state and no section frames when hasSelection is false', () => {
    render(
      <OfferingDetailRegion
        hasSelection={false}
        notFound={false}
        offering={null}
        locale="en-US"
        timezone="UTC"
      />,
    );

    expect(
      screen.getByText(
        "Select an offering to view its details, specifications, and prices.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Details")).not.toBeInTheDocument();
    expect(screen.queryByText("Specifications")).not.toBeInTheDocument();
    expect(screen.queryByText("Prices")).not.toBeInTheDocument();
  });

  it('renders the "Offering not found" state when hasSelection is true and notFound is true', () => {
    render(
      <OfferingDetailRegion
        hasSelection={true}
        notFound={true}
        offering={null}
        locale="en-US"
        timezone="UTC"
      />,
    );

    expect(screen.getByText("Offering not found")).toBeInTheDocument();
    expect(screen.queryByText("Details")).not.toBeInTheDocument();
  });

  it("renders the populated Details, Specifications, and Prices sections when hasSelection is true and notFound is false", () => {
    render(
      <OfferingDetailRegion
        hasSelection={true}
        notFound={false}
        offering={FIXTURE_OFFERING}
        locale="en-US"
        timezone="UTC"
      />,
    );

    expect(screen.getByText("Details")).toBeInTheDocument();
    expect(screen.getByText("5G Nationwide Service Plan")).toBeInTheDocument();
    expect(screen.getByText("PRDOFR000001")).toBeInTheDocument();
    expect(screen.getByText("Specifications")).toBeInTheDocument();
    expect(screen.getByText("Network Slice eMBB")).toBeInTheDocument();
    expect(screen.getByText("PRDSMD000001")).toBeInTheDocument();
    expect(screen.getByText("Prices")).toBeInTheDocument();
    expect(screen.getByText("Monthly Recurring Charge")).toBeInTheDocument();
    expect(screen.getByText("PRDOFP000001")).toBeInTheDocument();
  });
});
