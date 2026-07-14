import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PreferredIndicator } from "@/components/customers/preferred-indicator";

describe("PreferredIndicator", () => {
  it("renders a filled star with the accent color class and a default aria-label", () => {
    render(<PreferredIndicator />);

    const star = screen.getByLabelText("Preferred");
    expect(star).toBeInTheDocument();
    expect(star).toHaveClass("fill-current");
  });

  it("a passed label prop overrides the default", () => {
    render(<PreferredIndicator label="Preferred phone" />);

    expect(screen.getByLabelText("Preferred phone")).toBeInTheDocument();
    expect(screen.queryByLabelText("Preferred")).not.toBeInTheDocument();
  });
});
