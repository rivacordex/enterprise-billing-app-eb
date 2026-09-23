import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ComponentTypePicker } from "@/components/products/manage/component-type-picker";
import { COMPONENT_TYPES } from "@/types/product";

describe("ComponentTypePicker", () => {
  it("renders exactly the four persistable types and never negotiated_override", () => {
    render(<ComponentTypePicker value="usage_rate" onChange={vi.fn()} />);

    expect(screen.getAllByRole("radio")).toHaveLength(COMPONENT_TYPES.length);
    expect(screen.getByRole("radio", { name: "Usage rate" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Flat fee" })).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "Target capacity commitment" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "Target capacity motivation" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/negotiated/i)).not.toBeInTheDocument();
  });

  it("each option shows one line of help, not folded into the accessible name", () => {
    render(<ComponentTypePicker value="usage_rate" onChange={vi.fn()} />);

    expect(
      screen.getByText("A per-unit rate applied to metered usage."),
    ).toBeInTheDocument();
    // The accessible name is the badge label alone (exact match succeeds).
    expect(
      screen.getByRole("radio", { name: "Usage rate" }),
    ).toBeInTheDocument();
  });

  it("calls onChange with the selected type", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ComponentTypePicker value="usage_rate" onChange={onChange} />);

    await user.click(screen.getByRole("radio", { name: "Flat fee" }));
    expect(onChange).toHaveBeenCalledWith("flat_fee");
  });

  it("no accent-filled treatment appears anywhere in the picker", () => {
    const { container } = render(
      <ComponentTypePicker value="usage_rate" onChange={vi.fn()} />,
    );
    expect(container.innerHTML).not.toContain("--action-cta-bg");
  });
});
