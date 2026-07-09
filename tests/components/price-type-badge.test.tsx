import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PriceTypeBadge } from "@/components/products/price-type-badge";

describe("PriceTypeBadge", () => {
  it("renders the Recurring label with the primary tint", () => {
    render(<PriceTypeBadge priceType="recurring" />);
    const badge = screen.getByText("Recurring").closest("span");
    expect(badge).toHaveClass("text-[color:var(--color-primary-700)]");
  });

  it("renders the Usage label with the cyan tint", () => {
    render(<PriceTypeBadge priceType="usage" />);
    const badge = screen.getByText("Usage").closest("span");
    expect(badge).toHaveClass("text-[color:var(--color-cyan-700)]");
  });

  it("renders the Once label with the neutral tint", () => {
    render(<PriceTypeBadge priceType="once" />);
    const badge = screen.getByText("Once").closest("span");
    expect(badge).toHaveClass("text-[color:var(--color-neutral-700)]");
  });

  it("pairs every badge's icon with a text label", () => {
    render(<PriceTypeBadge priceType="recurring" />);
    const badge = screen.getByText("Recurring").closest("span");
    expect(badge?.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});
