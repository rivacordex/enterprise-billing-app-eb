import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TierTable } from "@/components/products/tier-table";
import type { Tier } from "@/validation/product/pricing-characteristics.schema";

const TIERS: Tier[] = [
  { from: 0, to: 1000, rate: "0.05" },
  { from: 1000, to: 10000, rate: "0.04" },
  { from: 10000, to: null, rate: "0.03" },
];

describe("TierTable", () => {
  it("renders one row per tier in array order with the From/To/Rate header", () => {
    render(<TierTable tiers={TIERS} />);

    expect(
      screen.getByRole("columnheader", { name: "From" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "To" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Rate" }),
    ).toBeInTheDocument();

    const rows = screen.getAllByRole("row").slice(1); // skip header row
    expect(rows).toHaveLength(3);
  });

  it("prints stored bounds verbatim (no locale grouping) and stored rate text (no formatCurrency)", () => {
    render(<TierTable tiers={TIERS} />);

    expect(screen.getAllByText("1000")).toHaveLength(2); // row1.to, row2.from
    expect(screen.queryByText("1,000")).not.toBeInTheDocument();
    expect(screen.getAllByText("10000")).toHaveLength(2); // row2.to, row3.from
    expect(screen.queryByText("10,000")).not.toBeInTheDocument();
    expect(screen.getByText("0.05")).toBeInTheDocument();
    expect(screen.getByText("0.04")).toBeInTheDocument();
    expect(screen.getByText("0.03")).toBeInTheDocument();
  });

  it('renders "and above" for the open-ended top tier', () => {
    render(<TierTable tiers={TIERS} />);
    expect(screen.getByText("and above")).toBeInTheDocument();
  });
});
