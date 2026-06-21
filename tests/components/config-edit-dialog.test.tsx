import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/actions/system-config/update-config.action", () => ({
  updateConfigAction: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { updateConfigAction } from "@/actions/system-config/update-config.action";
import { toast } from "sonner";

import { ConfigEditDialog } from "@/components/system-config/config-edit-dialog";

const mockUpdateConfigAction = vi.mocked(updateConfigAction);
const mockToastSuccess = vi.mocked(toast.success);

function renderDialog(initialValue: string | null = "current-value") {
  return render(
    <ConfigEditDialog
      configId="config-1"
      configKey="app_name"
      configGroup="app"
      initialValue={initialValue}
    />,
  );
}

beforeEach(() => {
  mockUpdateConfigAction.mockReset();
  mockToastSuccess.mockReset();
});

describe("ConfigEditDialog", () => {
  it("renders the trigger with an accessible label and no dialog content initially", () => {
    renderDialog();
    expect(
      screen.getByRole("button", { name: "Edit configuration value" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Edit configuration" }),
    ).not.toBeInTheDocument();
  });

  it("clicking the trigger opens the dialog showing group and key", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(
      screen.getByRole("button", { name: "Edit configuration value" }),
    );

    expect(
      screen.getByRole("heading", { name: "Edit configuration" }),
    ).toBeInTheDocument();
    expect(screen.getByText("app")).toBeInTheDocument();
    expect(screen.getByText("app_name")).toBeInTheDocument();
  });

  it("pre-populates the textarea with initialValue", async () => {
    const user = userEvent.setup();
    renderDialog("current-value");

    await user.click(
      screen.getByRole("button", { name: "Edit configuration value" }),
    );

    expect(screen.getByLabelText("Value")).toHaveValue("current-value");
  });

  it("renders an empty textarea when initialValue is null", async () => {
    const user = userEvent.setup();
    renderDialog(null);

    await user.click(
      screen.getByRole("button", { name: "Edit configuration value" }),
    );

    expect(screen.getByLabelText("Value")).toHaveValue("");
  });

  it("submits the coerced value to updateConfigAction", async () => {
    mockUpdateConfigAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderDialog("old");

    await user.click(
      screen.getByRole("button", { name: "Edit configuration value" }),
    );
    await user.clear(screen.getByLabelText("Value"));
    await user.type(screen.getByLabelText("Value"), "new-value");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(mockUpdateConfigAction).toHaveBeenCalledWith({
        configId: "config-1",
        configValue: "new-value",
      });
    });
  });

  it("coerces a whitespace-only value to null", async () => {
    mockUpdateConfigAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderDialog("old");

    await user.click(
      screen.getByRole("button", { name: "Edit configuration value" }),
    );
    await user.clear(screen.getByLabelText("Value"));
    await user.type(screen.getByLabelText("Value"), "   ");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(mockUpdateConfigAction).toHaveBeenCalledWith({
        configId: "config-1",
        configValue: null,
      });
    });
  });

  it("coerces an empty value to null", async () => {
    mockUpdateConfigAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderDialog("old");

    await user.click(
      screen.getByRole("button", { name: "Edit configuration value" }),
    );
    await user.clear(screen.getByLabelText("Value"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(mockUpdateConfigAction).toHaveBeenCalledWith({
        configId: "config-1",
        configValue: null,
      });
    });
  });

  it("on success closes the dialog and toasts", async () => {
    mockUpdateConfigAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderDialog("old");

    await user.click(
      screen.getByRole("button", { name: "Edit configuration value" }),
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith("Configuration updated.");
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Edit configuration" }),
      ).not.toBeInTheDocument();
    });
  });

  it.each([
    [
      "NOT_FOUND",
      "Configuration parameter not found. It may have been modified by another admin.",
    ],
    [
      "SECRET_ROW",
      "This parameter is marked secret and cannot be edited here.",
    ],
    [
      "FORBIDDEN",
      "You don't have permission to edit configuration parameters.",
    ],
    ["SERVER_ERROR", "Something went wrong. Please try again."],
  ] as const)(
    "on %s shows the matching inline error and keeps the dialog open",
    async (code, message) => {
      mockUpdateConfigAction.mockResolvedValue({ ok: false, code });
      const user = userEvent.setup();
      renderDialog("old");

      await user.click(
        screen.getByRole("button", { name: "Edit configuration value" }),
      );
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Edit configuration" }),
      ).toBeInTheDocument();
    },
  );

  it("disables Save changes and Cancel while submitting", async () => {
    let resolveAction!: (value: { ok: true }) => void;
    mockUpdateConfigAction.mockReturnValue(
      new Promise((resolve) => {
        resolveAction = resolve;
      }),
    );
    const user = userEvent.setup();
    renderDialog("old");

    await user.click(
      screen.getByRole("button", { name: "Edit configuration value" }),
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(screen.getByRole("button", { name: /Save changes/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    resolveAction({ ok: true });
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
  });

  it("Cancel closes the dialog, resets the value, and clears the error", async () => {
    mockUpdateConfigAction.mockResolvedValue({
      ok: false,
      code: "SERVER_ERROR",
    });
    const user = userEvent.setup();
    renderDialog("original");

    await user.click(
      screen.getByRole("button", { name: "Edit configuration value" }),
    );
    await user.clear(screen.getByLabelText("Value"));
    await user.type(screen.getByLabelText("Value"), "edited");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Something went wrong. Please try again.");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("heading", { name: "Edit configuration" }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Edit configuration value" }),
    );
    expect(screen.getByLabelText("Value")).toHaveValue("original");
    expect(
      screen.queryByText("Something went wrong. Please try again."),
    ).not.toBeInTheDocument();
  });
});
