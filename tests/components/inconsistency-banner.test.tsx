import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { InconsistencyBanner } from "@/components/customers/inconsistency-banner";

describe("InconsistencyBanner", () => {
  it("renders both statuses in the message with role=status and a hidden icon", () => {
    render(
      <InconsistencyBanner
        organizationStatus="SUSPENDED"
        customerStatus="ACTIVE"
      />,
    );

    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("SUSPENDED");
    expect(banner).toHaveTextContent("ACTIVE");

    const icon = banner.querySelector("svg");
    expect(icon).toHaveAttribute("aria-hidden");
  });

  it("renders the warning treatment, never a destructive/blocking one", () => {
    render(
      <InconsistencyBanner
        organizationStatus="DISSOLVED"
        customerStatus="INITIALIZED"
      />,
    );

    const banner = screen.getByRole("status");
    expect(banner.className).toContain("--banner-warning-bg");
    expect(banner.className).not.toMatch(/danger|destructive|red/i);
  });
});
