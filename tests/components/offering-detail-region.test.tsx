import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OfferingDetailRegion } from "@/components/products/offering-detail-region";

describe("OfferingDetailRegion", () => {
  it('renders the "Select an offering" empty state and no section frames when hasSelection is false', () => {
    render(<OfferingDetailRegion hasSelection={false} notFound={false} />);

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
    render(<OfferingDetailRegion hasSelection={true} notFound={true} />);

    expect(screen.getByText("Offering not found")).toBeInTheDocument();
    expect(screen.queryByText("Details")).not.toBeInTheDocument();
  });

  it("renders the three titled section frames when hasSelection is true and notFound is false", () => {
    render(<OfferingDetailRegion hasSelection={true} notFound={false} />);

    expect(screen.getByText("Details")).toBeInTheDocument();
    expect(screen.getByText("Specifications")).toBeInTheDocument();
    expect(screen.getByText("Prices")).toBeInTheDocument();
  });
});
