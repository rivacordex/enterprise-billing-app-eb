import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SpecificationsPanel } from "@/components/products/specifications-panel";
import type { SpecificationCard } from "@/types/product";

function makeSpec(
  overrides: Partial<SpecificationCard> = {},
): SpecificationCard {
  return {
    productSpecId: "PRDSMD000001",
    name: "Network Slice eMBB",
    isMandatory: false,
    isDefault: false,
    defaultValue: null,
    characteristics: {},
    ...overrides,
  };
}

describe("SpecificationsPanel", () => {
  it("renders one card per spec with its mono productSpecId eyebrow and name", () => {
    render(
      <SpecificationsPanel
        specifications={[
          makeSpec({
            productSpecId: "PRDSMD000001",
            name: "Network Slice eMBB",
          }),
          makeSpec({ productSpecId: "PRDSMD000002", name: "QoS Profile" }),
        ]}
      />,
    );

    expect(screen.getByText("PRDSMD000001")).toBeInTheDocument();
    expect(screen.getByText("Network Slice eMBB")).toBeInTheDocument();
    expect(screen.getByText("PRDSMD000002")).toBeInTheDocument();
    expect(screen.getByText("QoS Profile")).toBeInTheDocument();
  });

  it("shows the Mandatory badge only when isMandatory is true", () => {
    const { rerender } = render(
      <SpecificationsPanel
        specifications={[makeSpec({ isMandatory: true })]}
      />,
    );
    expect(screen.getByText("Mandatory")).toBeInTheDocument();

    rerender(
      <SpecificationsPanel
        specifications={[makeSpec({ isMandatory: false })]}
      />,
    );
    expect(screen.queryByText("Mandatory")).not.toBeInTheDocument();
  });

  it("shows the Default badge only when isDefault is true", () => {
    const { rerender } = render(
      <SpecificationsPanel specifications={[makeSpec({ isDefault: true })]} />,
    );
    expect(screen.getByText("Default")).toBeInTheDocument();

    rerender(
      <SpecificationsPanel specifications={[makeSpec({ isDefault: false })]} />,
    );
    expect(screen.queryByText("Default")).not.toBeInTheDocument();
  });

  it("shows the Default value row when defaultValue is set and omits it when null", () => {
    const { rerender } = render(
      <SpecificationsPanel
        specifications={[makeSpec({ defaultValue: "standard" })]}
      />,
    );
    expect(screen.getByText("Default value")).toBeInTheDocument();
    expect(screen.getByText("standard")).toBeInTheDocument();

    rerender(
      <SpecificationsPanel
        specifications={[makeSpec({ defaultValue: null })]}
      />,
    );
    expect(screen.queryByText("Default value")).not.toBeInTheDocument();
  });

  it("shows the Default badge without a value row when isDefault is true and defaultValue is null", () => {
    render(
      <SpecificationsPanel
        specifications={[makeSpec({ isDefault: true, defaultValue: null })]}
      />,
    );

    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(screen.queryByText("Default value")).not.toBeInTheDocument();
  });

  it("shows the value row without a Default badge when isDefault is false and defaultValue is set", () => {
    render(
      <SpecificationsPanel
        specifications={[
          makeSpec({ isDefault: false, defaultValue: "standard" }),
        ]}
      />,
    );

    expect(screen.queryByText("Default")).not.toBeInTheDocument();
    expect(screen.getByText("Default value")).toBeInTheDocument();
    expect(screen.getByText("standard")).toBeInTheDocument();
  });

  it("renders characteristics as plain text in insertion order and none for an empty object", () => {
    const { rerender } = render(
      <SpecificationsPanel
        specifications={[
          makeSpec({
            characteristics: { SST_ID: "01", SD_ID: "A0C4E2" },
          }),
        ]}
      />,
    );

    const sstId = screen.getByText("SST_ID");
    const sdId = screen.getByText("SD_ID");
    expect(sstId).toBeInTheDocument();
    expect(sdId).toBeInTheDocument();
    expect(screen.getByText("01")).toBeInTheDocument();
    expect(screen.getByText("A0C4E2")).toBeInTheDocument();

    const position =
      sstId.compareDocumentPosition(sdId) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(position).toBeTruthy();

    rerender(
      <SpecificationsPanel
        specifications={[makeSpec({ characteristics: {} })]}
      />,
    );
    expect(screen.queryByText("SST_ID")).not.toBeInTheDocument();
    expect(screen.getByText("Network Slice eMBB")).toBeInTheDocument();
  });

  it('renders the "No specifications for this offering." empty state when specifications is empty', () => {
    render(<SpecificationsPanel specifications={[]} />);

    expect(
      screen.getByText("No specifications for this offering."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Default value")).not.toBeInTheDocument();
  });

  it("pairs every badge's icon with a text label", () => {
    render(
      <SpecificationsPanel
        specifications={[makeSpec({ isMandatory: true, isDefault: true })]}
      />,
    );

    const mandatoryBadge = screen.getByText("Mandatory").closest("span");
    expect(mandatoryBadge?.querySelector("svg")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    const defaultBadge = screen.getByText("Default").closest("span");
    expect(defaultBadge?.querySelector("svg")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });
});
