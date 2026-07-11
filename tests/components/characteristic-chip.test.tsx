import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CharacteristicChip } from "@/components/products/characteristic-chip";

describe("CharacteristicChip", () => {
  it("renders the key as an overline label and the value in a mono class", () => {
    render(<CharacteristicChip chKey="SST_ID" value="01" />);

    const keyEl = screen.getByText("SST_ID");
    const valueEl = screen.getByText("01");

    expect(keyEl).toBeInTheDocument();
    expect(valueEl).toBeInTheDocument();
    expect(valueEl.className).toMatch(/font-mono/);
    expect(valueEl.className).toMatch(/tabular-nums/);
  });
});
