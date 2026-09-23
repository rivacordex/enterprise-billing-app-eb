import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OfferingComponentErrorBanner } from "@/components/products/manage/offering-component-error-banner";

describe("OfferingComponentErrorBanner", () => {
  it("renders nothing when there is no violation", () => {
    const { container } = render(
      <OfferingComponentErrorBanner violation={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("MODIFIER_WITHOUT_BASE_RATE names the offending component by badge label and the unit", () => {
    render(
      <OfferingComponentErrorBanner
        violation={{
          code: "MODIFIER_WITHOUT_BASE_RATE",
          unitOfMeasure: "EA",
          componentType: "capacity_commitment",
        }}
      />,
    );
    expect(
      screen.getByText(
        "Target capacity commitment needs a base usage rate in EA. Add one before saving.",
      ),
    ).toBeInTheDocument();
  });

  it("AMBIGUOUS_BASE_RATE names the unit and points at the start date or the existing rate", () => {
    render(
      <OfferingComponentErrorBanner
        violation={{ code: "AMBIGUOUS_BASE_RATE", unitOfMeasure: "GB" }}
      />,
    );
    expect(
      screen.getByText(/already has a usage rate in GB effective on that date/),
    ).toBeInTheDocument();
  });

  it("CURRENCY_MISMATCH names both currencies", () => {
    render(
      <OfferingComponentErrorBanner
        violation={{
          code: "CURRENCY_MISMATCH",
          existingCurrency: "MYR",
          candidateCurrency: "USD",
        }}
      />,
    );
    expect(
      screen.getByText(
        "This offering's components are priced in MYR. USD cannot be mixed in.",
      ),
    ).toBeInTheDocument();
  });

  it("uses the danger role, not the warning tint", () => {
    render(
      <OfferingComponentErrorBanner
        violation={{ code: "AMBIGUOUS_BASE_RATE", unitOfMeasure: "EA" }}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.className).toContain("--bg-danger");
    expect(alert.className).toContain("--text-danger");
    expect(alert.className).not.toContain("--bg-warning");
  });
});
