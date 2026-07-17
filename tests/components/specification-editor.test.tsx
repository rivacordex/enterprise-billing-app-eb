import { render, screen } from "@testing-library/react";
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

  // The error is derived from the controlled `value` prop during render, not
  // from typed keystrokes — a caller that doesn't feed a new `value` back in
  // (e.g. a no-op `onChange`) must not see a stale, internally-tracked error.
  it("shows 'Must be a JSON object.' for a top-level array value", () => {
    render(<SpecificationEditor value="[1,2]" onChange={vi.fn()} />);

    expect(screen.getByText("Must be a JSON object.")).toBeInTheDocument();
  });

  it("shows 'Must be a JSON object.' for a top-level primitive value", () => {
    render(<SpecificationEditor value="42" onChange={vi.fn()} />);

    expect(screen.getByText("Must be a JSON object.")).toBeInTheDocument();
  });

  it("shows 'Invalid JSON.' for malformed JSON value", () => {
    render(<SpecificationEditor value="{not json" onChange={vi.fn()} />);

    expect(screen.getByText("Invalid JSON.")).toBeInTheDocument();
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
