import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  CapacityMotivationStepsEditor,
  type StepRow,
} from "@/components/products/manage/capacity-motivation-steps-editor";

// A stateful controlled harness — CapacityMotivationStepsEditor is a plain
// controlled component with no state of its own, so exercising a typed
// keystroke-by-keystroke change needs the harness to feed onChange back into
// what's rendered, exactly as price-form.tsx's Controller wiring does.
function Harness({
  initial,
  onChange,
}: {
  initial: StepRow[];
  onChange: (rows: StepRow[]) => void;
}) {
  const [rows, setRows] = useState(initial);
  return (
    <CapacityMotivationStepsEditor
      value={rows}
      onChange={(next) => {
        setRows(next);
        onChange(next);
      }}
    />
  );
}

describe("CapacityMotivationStepsEditor", () => {
  it("renders as a row list with an accessible name, never a JSON textarea", () => {
    render(
      <Harness
        initial={[{ aboveQuantity: "1000", ratePerUnit: "50" }]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("group", { name: "Steps" })).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: /json/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Above quantity")).toHaveValue("1000");
    expect(screen.getByLabelText("Rate per unit")).toHaveValue("50");
  });

  it("Add appends a row", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Harness
        initial={[{ aboveQuantity: "1000", ratePerUnit: "50" }]}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add step" }));
    expect(onChange).toHaveBeenCalledWith([
      { aboveQuantity: "1000", ratePerUnit: "50" },
      { aboveQuantity: "", ratePerUnit: "" },
    ]);
  });

  it("Remove removes the targeted row when more than one remains", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Harness
        initial={[
          { aboveQuantity: "1000", ratePerUnit: "50" },
          { aboveQuantity: "2000", ratePerUnit: "25" },
        ]}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Remove step 1" }));
    expect(onChange).toHaveBeenCalledWith([
      { aboveQuantity: "2000", ratePerUnit: "25" },
    ]);
  });

  it("removing the last row is refused with a field-level message, the control stays enabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Harness
        initial={[{ aboveQuantity: "1000", ratePerUnit: "50" }]}
        onChange={onChange}
      />,
    );

    const removeButton = screen.getByRole("button", { name: "Remove step 1" });
    expect(removeButton).not.toBeDisabled();
    await user.click(removeButton);

    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen.getByText("At least one step is required."),
    ).toBeInTheDocument();
  });

  it("reorders ascending on blur of the edited row (D2), not on every keystroke", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Harness
        initial={[
          { aboveQuantity: "2000", ratePerUnit: "25" },
          { aboveQuantity: "1000", ratePerUnit: "50" },
        ]}
        onChange={onChange}
      />,
    );

    const secondAbove = screen.getAllByLabelText("Above quantity")[1]!;
    await user.clear(secondAbove);
    await user.type(secondAbove, "500");
    expect(onChange).not.toHaveBeenCalledWith([
      { aboveQuantity: "500", ratePerUnit: "50" },
      { aboveQuantity: "2000", ratePerUnit: "25" },
    ]);

    await user.tab();
    expect(onChange).toHaveBeenLastCalledWith([
      { aboveQuantity: "500", ratePerUnit: "50" },
      { aboveQuantity: "2000", ratePerUnit: "25" },
    ]);
  });

  it("flags a duplicate threshold with a field-level message naming the value", () => {
    render(
      <Harness
        initial={[
          { aboveQuantity: "1000", ratePerUnit: "50" },
          { aboveQuantity: "1000", ratePerUnit: "25" },
        ]}
        onChange={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Duplicate threshold — a step already exists for 1000."),
    ).toBeInTheDocument();
  });
});
