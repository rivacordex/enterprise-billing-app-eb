import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/actions/auth/set-password.action", () => ({
  setPasswordAction: vi.fn(),
}));

import { setPasswordAction } from "@/actions/auth/set-password.action";

import { SetPasswordForm } from "@/components/auth/set-password-form";

const mockSetPasswordAction = vi.mocked(setPasswordAction);

beforeEach(() => {
  mockSetPasswordAction.mockReset();
});

describe("SetPasswordForm", () => {
  it("renders both password fields as type password by default", () => {
    render(<SetPasswordForm />);

    expect(screen.getByLabelText("New Password")).toHaveAttribute(
      "type",
      "password",
    );
    expect(screen.getByLabelText("Confirm Password")).toHaveAttribute(
      "type",
      "password",
    );
  });

  it("toggles only the New Password field's visibility", async () => {
    const user = userEvent.setup();
    render(<SetPasswordForm />);

    const toggles = screen.getAllByRole("button", { name: "Show password" });
    await user.click(toggles[0]!);

    expect(screen.getByLabelText("New Password")).toHaveAttribute(
      "type",
      "text",
    );
    expect(screen.getByLabelText("Confirm Password")).toHaveAttribute(
      "type",
      "password",
    );
  });

  it("reverts to type password when the toggle is clicked again", async () => {
    const user = userEvent.setup();
    render(<SetPasswordForm />);

    const toggle = screen.getAllByRole("button", {
      name: "Show password",
    })[0]!;
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Hide password" }));

    expect(screen.getByLabelText("New Password")).toHaveAttribute(
      "type",
      "password",
    );
  });

  it("shows a field error and does not call the action for a too-short password", async () => {
    const user = userEvent.setup();
    render(<SetPasswordForm />);

    await user.type(screen.getByLabelText("New Password"), "short");
    await user.type(screen.getByLabelText("Confirm Password"), "short");
    await user.click(screen.getByRole("button", { name: "Set Password" }));

    expect(
      await screen.findByText("Password must be at least 12 characters."),
    ).toBeInTheDocument();
    expect(mockSetPasswordAction).not.toHaveBeenCalled();
  });

  it("shows a mismatch error below Confirm Password", async () => {
    const user = userEvent.setup();
    render(<SetPasswordForm />);

    await user.type(screen.getByLabelText("New Password"), "ValidPassword123");
    await user.type(
      screen.getByLabelText("Confirm Password"),
      "DifferentPassword123",
    );
    await user.click(screen.getByRole("button", { name: "Set Password" }));

    expect(
      await screen.findByText("Passwords do not match."),
    ).toBeInTheDocument();
    expect(mockSetPasswordAction).not.toHaveBeenCalled();
  });

  it("calls setPasswordAction with valid matching passwords", async () => {
    mockSetPasswordAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<SetPasswordForm />);

    await user.type(screen.getByLabelText("New Password"), "ValidPassword123");
    await user.type(
      screen.getByLabelText("Confirm Password"),
      "ValidPassword123",
    );
    await user.click(screen.getByRole("button", { name: "Set Password" }));

    await waitFor(() =>
      expect(mockSetPasswordAction).toHaveBeenCalledWith({
        newPassword: "ValidPassword123",
        confirmPassword: "ValidPassword123",
      }),
    );
  });

  it("shows an alert banner when the action returns SERVER_ERROR", async () => {
    mockSetPasswordAction.mockResolvedValue({
      ok: false,
      code: "SERVER_ERROR",
    });
    const user = userEvent.setup();
    render(<SetPasswordForm />);

    await user.type(screen.getByLabelText("New Password"), "ValidPassword123");
    await user.type(
      screen.getByLabelText("Confirm Password"),
      "ValidPassword123",
    );
    await user.click(screen.getByRole("button", { name: "Set Password" }));

    expect(
      await screen.findByText("Something went wrong. Please try again."),
    ).toBeInTheDocument();
  });

  it("sets the server-returned field error when the action returns VALIDATION_ERROR", async () => {
    mockSetPasswordAction.mockResolvedValue({
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: { newPassword: ["Server says this is too weak."] },
    });
    const user = userEvent.setup();
    render(<SetPasswordForm />);

    await user.type(screen.getByLabelText("New Password"), "ValidPassword123");
    await user.type(
      screen.getByLabelText("Confirm Password"),
      "ValidPassword123",
    );
    await user.click(screen.getByRole("button", { name: "Set Password" }));

    expect(
      await screen.findByText("Server says this is too weak."),
    ).toBeInTheDocument();
  });
});
