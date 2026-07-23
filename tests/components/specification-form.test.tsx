import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SpecificationForm } from "@/components/products/manage/specification-form";

function renderForm(
  overrides: Partial<React.ComponentProps<typeof SpecificationForm>> = {},
) {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const utils = render(
    <SpecificationForm
      mode={overrides.defaultValues ? "edit" : "create"}
      formId="specification-form"
      onSubmit={onSubmit}
      isSubmitting={false}
      {...overrides}
    />,
  );
  return { onSubmit, ...utils };
}

function submit(): void {
  const form = document.getElementById("specification-form");
  if (!form) throw new Error("form not found");
  fireEvent.submit(form);
}

describe("SpecificationForm", () => {
  it("create mode with no defaultValues starts with an empty characteristics list", () => {
    renderForm();

    expect(
      screen.queryByLabelText("Characteristic 1 key"),
    ).not.toBeInTheDocument();
  });

  it("'Add characteristic' appends one blank key/value row", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(
      screen.getByRole("button", { name: "Add characteristic" }),
    );

    expect(screen.getByLabelText("Characteristic 1 key")).toHaveValue("");
    expect(screen.getByLabelText("Characteristic 1 value")).toHaveValue("");
  });

  it("submitting with a blank required field shows a FieldError", async () => {
    const { onSubmit } = renderForm();

    submit();

    expect(
      await screen.findByText("Specification name is required"),
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submitting two characteristic rows with the same key shows the duplicate-key error and does not call onSubmit", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();

    await user.type(screen.getByLabelText("Name"), "Color");
    await user.click(
      screen.getByRole("button", { name: "Add characteristic" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Add characteristic" }),
    );

    await user.type(screen.getByLabelText("Characteristic 1 key"), "HEX");
    await user.type(screen.getByLabelText("Characteristic 1 value"), "FF0000");
    await user.type(screen.getByLabelText("Characteristic 2 key"), "HEX");
    await user.type(screen.getByLabelText("Characteristic 2 value"), "00FF00");

    submit();

    expect(
      await screen.findByText("Characteristic keys must be unique"),
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("a successful submit calls onSubmit with productSpecCharacteristics as a flat Record and defaultValue: null when blank", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();

    await user.type(screen.getByLabelText("Name"), "Color");
    await user.click(
      screen.getByRole("button", { name: "Add characteristic" }),
    );
    await user.type(screen.getByLabelText("Characteristic 1 key"), "HEX");
    await user.type(screen.getByLabelText("Characteristic 1 value"), "FF0000");

    submit();

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        name: "Color",
        isMandatory: false,
        isDefault: false,
        defaultValue: null,
        productSpecCharacteristics: { HEX: "FF0000" },
      });
    });
  });

  it("edit mode prefills exactly two characteristic rows from defaultValues.characteristics", () => {
    renderForm({
      defaultValues: {
        name: "Color",
        isMandatory: true,
        isDefault: false,
        defaultValue: "Red",
        characteristics: { SST_ID: "01", SD_ID: "02" },
      },
    });

    expect(screen.getByLabelText("Name")).toHaveValue("Color");
    expect(screen.getByLabelText("Default value")).toHaveValue("Red");
    expect(screen.getByLabelText("Characteristic 1 key")).toHaveValue("SST_ID");
    expect(screen.getByLabelText("Characteristic 1 value")).toHaveValue("01");
    expect(screen.getByLabelText("Characteristic 2 key")).toHaveValue("SD_ID");
    expect(screen.getByLabelText("Characteristic 2 value")).toHaveValue("02");
    expect(
      screen.queryByLabelText("Characteristic 3 key"),
    ).not.toBeInTheDocument();
  });
});
