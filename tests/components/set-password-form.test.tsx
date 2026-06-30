import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/actions/auth/set-password.action", () => ({
  setPasswordAction: vi.fn(),
}));

import { setPasswordAction } from "@/actions/auth/set-password.action";

import { SetPasswordForm } from "@/components/auth/set-password-form";

const mockSetPasswordAction = vi.mocked(setPasswordAction);

const VALID = "ValidPassword123!";

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
      await screen.findByText("Password must be at least 15 characters."),
    ).toBeInTheDocument();
    expect(mockSetPasswordAction).not.toHaveBeenCalled();
  });

  it("shows every violated rule at once for a weak password", async () => {
    const user = userEvent.setup();
    render(<SetPasswordForm />);

    // Too short, no uppercase, no special char.
    await user.type(screen.getByLabelText("New Password"), "weak123");
    await user.type(screen.getByLabelText("Confirm Password"), "weak123");
    await user.click(screen.getByRole("button", { name: "Set Password" }));

    expect(
      await screen.findByText("Password must be at least 15 characters."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Password must contain at least one uppercase letter."),
    ).toBeInTheDocument();
    expect(mockSetPasswordAction).not.toHaveBeenCalled();
  });

  it("shows a mismatch error below Confirm Password", async () => {
    const user = userEvent.setup();
    render(<SetPasswordForm />);

    await user.type(screen.getByLabelText("New Password"), VALID);
    await user.type(
      screen.getByLabelText("Confirm Password"),
      "DifferentPassword123!",
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

    await user.type(screen.getByLabelText("New Password"), VALID);
    await user.type(screen.getByLabelText("Confirm Password"), VALID);
    await user.click(screen.getByRole("button", { name: "Set Password" }));

    await waitFor(() =>
      expect(mockSetPasswordAction).toHaveBeenCalledWith({
        newPassword: VALID,
        confirmPassword: VALID,
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

    await user.type(screen.getByLabelText("New Password"), VALID);
    await user.type(screen.getByLabelText("Confirm Password"), VALID);
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

    await user.type(screen.getByLabelText("New Password"), VALID);
    await user.type(screen.getByLabelText("Confirm Password"), VALID);
    await user.click(screen.getByRole("button", { name: "Set Password" }));

    expect(
      await screen.findByText("Server says this is too weak."),
    ).toBeInTheDocument();
  });

  it("shows every server-returned field error simultaneously", async () => {
    mockSetPasswordAction.mockResolvedValue({
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: {
        newPassword: ["Server rule one failed.", "Server rule two failed."],
      },
    });
    const user = userEvent.setup();
    render(<SetPasswordForm />);

    await user.type(screen.getByLabelText("New Password"), VALID);
    await user.type(screen.getByLabelText("Confirm Password"), VALID);
    await user.click(screen.getByRole("button", { name: "Set Password" }));

    expect(
      await screen.findByText("Server rule one failed."),
    ).toBeInTheDocument();
    expect(screen.getByText("Server rule two failed.")).toBeInTheDocument();
  });

  it("renders the password policy hints when provided", () => {
    render(
      <SetPasswordForm passwordPolicyHints={["At least 15 characters"]} />,
    );

    expect(screen.getByText("At least 15 characters")).toBeInTheDocument();
  });
});
