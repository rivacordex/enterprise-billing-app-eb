import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SpecificationEditor } from "@/components/customers/specification-editor";

describe("SpecificationEditor", () => {
  it("shows no error message for valid JSON object text", () => {
    render(<SpecificationEditor value='{"a":1}' onChange={vi.fn()} />);

    expect(screen.queryByText("Invalid JSON.")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Must be a JSON object."),
    ).not.toBeInTheDocument();
  });

  it("shows 'Must be a JSON object.' for a top-level array", async () => {
    render(<SpecificationEditor value="" onChange={vi.fn()} />);

    // `[`/`]`/`{`/`}` are special key-code delimiters to user-event's
    // `.type()`; setting the full value via a native change event avoids
    // that keyboard-parsing entirely.
    fireEvent.change(screen.getByLabelText("Party role specification (JSON)"), {
      target: { value: "[1,2]" },
    });

    expect(
      await screen.findByText("Must be a JSON object."),
    ).toBeInTheDocument();
  });

  it("shows 'Must be a JSON object.' for a top-level primitive", async () => {
    const user = userEvent.setup();
    render(<SpecificationEditor value="" onChange={vi.fn()} />);

    await user.type(
      screen.getByLabelText("Party role specification (JSON)"),
      "42",
    );

    expect(
      await screen.findByText("Must be a JSON object."),
    ).toBeInTheDocument();
  });

  it("shows 'Invalid JSON.' for malformed JSON text", async () => {
    render(<SpecificationEditor value="" onChange={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Party role specification (JSON)"), {
      target: { value: "{not json" },
    });

    expect(await screen.findByText("Invalid JSON.")).toBeInTheDocument();
  });

  it("fires onChange on every keystroke regardless of validity", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SpecificationEditor value="" onChange={onChange} />);

    await user.type(
      screen.getByLabelText("Party role specification (JSON)"),
      "x",
    );

    expect(onChange).toHaveBeenCalledWith("x");
  });
});
