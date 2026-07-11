import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OfferingDetail } from "@/components/products/offering-detail";
import type { OfferingDetail as OfferingDetailModel } from "@/types/product";

const BASE_OFFERING: OfferingDetailModel = {
  productOfferingId: "PRDOFR000001",
  name: "5G Nationwide Service Plan",
  isBundle: false,
  isSellable: true,
  billingOnly: false,
  lifecycleStatus: "ACTIVE",
  version: 3,
  lastModified: new Date("2026-07-03T14:22:00.000Z"),
  lastEditedByName: "Jordan Rivera",
  specifications: [],
  prices: [],
};

describe("OfferingDetail", () => {
  it("renders every product_offering field for a fully-populated offering", () => {
    render(
      <OfferingDetail offering={BASE_OFFERING} locale="en-US" timezone="UTC" />,
    );

    expect(screen.getByText("PRDOFR000001")).toBeInTheDocument();
    expect(screen.getByText("5G Nationwide Service Plan")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("Jordan Rivera")).toBeInTheDocument();
    expect(screen.getByText("Jul 03, 2026, 14:22")).toBeInTheDocument();
  });

  it("renders an em dash when lastEditedByName is null", () => {
    render(
      <OfferingDetail
        offering={{ ...BASE_OFFERING, lastEditedByName: null }}
        locale="en-US"
        timezone="UTC"
      />,
    );

    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("null")).not.toBeInTheDocument();
  });

  it("shows the Bundle chip when isBundle is true", () => {
    render(
      <OfferingDetail
        offering={{ ...BASE_OFFERING, isBundle: true }}
        locale="en-US"
        timezone="UTC"
      />,
    );

    expect(screen.getByText("Bundle")).toBeInTheDocument();
  });

  it("shows the Billing only chip when billingOnly is true", () => {
    render(
      <OfferingDetail
        offering={{ ...BASE_OFFERING, billingOnly: true }}
        locale="en-US"
        timezone="UTC"
      />,
    );

    expect(screen.getByText("Billing only")).toBeInTheDocument();
  });

  it("shows the Sellable chip when isSellable is true", () => {
    render(
      <OfferingDetail offering={BASE_OFFERING} locale="en-US" timezone="UTC" />,
    );

    expect(screen.getByText("Sellable")).toBeInTheDocument();
  });

  it("renders no flag chips when all flags are false and the offering is not the ACTIVE-not-sellable case", () => {
    render(
      <OfferingDetail
        offering={{
          ...BASE_OFFERING,
          isBundle: false,
          isSellable: false,
          billingOnly: false,
          lifecycleStatus: "DRAFT",
        }}
        locale="en-US"
        timezone="UTC"
      />,
    );

    expect(screen.queryByText("Bundle")).not.toBeInTheDocument();
    expect(screen.queryByText("Sellable")).not.toBeInTheDocument();
    expect(screen.queryByText("Not sellable")).not.toBeInTheDocument();
    expect(screen.queryByText("Billing only")).not.toBeInTheDocument();
  });

  it("shows the warning Not sellable chip when isSellable is false and lifecycleStatus is ACTIVE", () => {
    render(
      <OfferingDetail
        offering={{
          ...BASE_OFFERING,
          isSellable: false,
          lifecycleStatus: "ACTIVE",
        }}
        locale="en-US"
        timezone="UTC"
      />,
    );

    expect(screen.getByText("Not sellable")).toBeInTheDocument();
  });

  it("shows no sellable/not-sellable chip when isSellable is false and lifecycleStatus is not ACTIVE", () => {
    render(
      <OfferingDetail
        offering={{
          ...BASE_OFFERING,
          isSellable: false,
          lifecycleStatus: "DRAFT",
        }}
        locale="en-US"
        timezone="UTC"
      />,
    );

    expect(screen.queryByText("Sellable")).not.toBeInTheDocument();
    expect(screen.queryByText("Not sellable")).not.toBeInTheDocument();
  });

  it("pairs every chip's icon with a text label", () => {
    render(
      <OfferingDetail
        offering={{ ...BASE_OFFERING, isBundle: true, billingOnly: true }}
        locale="en-US"
        timezone="UTC"
      />,
    );

    const bundleChip = screen.getByText("Bundle").closest("span");
    expect(bundleChip?.querySelector("svg")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    const billingOnlyChip = screen.getByText("Billing only").closest("span");
    expect(billingOnlyChip?.querySelector("svg")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });
});
