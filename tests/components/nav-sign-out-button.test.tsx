import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockSignOut = vi.fn();
vi.mock("@/auth/client", () => ({
  authClient: { signOut: () => mockSignOut() },
}));

import { NavSignOutButton } from "@/components/nav-sign-out-button";

beforeEach(() => {
  mockPush.mockReset();
  mockSignOut.mockReset();
});

describe("NavSignOutButton", () => {
  it("renders a LogOut icon and 'Sign out' label in the default state", () => {
    render(<NavSignOutButton />);

    const button = screen.getByRole("button", { name: "Sign out" });
    expect(button).toBeInTheDocument();
    expect(button).toHaveTextContent("Sign out");
    expect(button).not.toBeDisabled();
  });

  it("applies dark-nav surface token classes", () => {
    render(<NavSignOutButton />);

    const button = screen.getByRole("button", { name: "Sign out" });
    expect(button.className).toContain("text-[color:var(--color-primary-300)]");
    expect(button.className).toContain(
      "hover:bg-[color:var(--color-primary-700)]",
    );
  });

  it("shows the pending state (spinner + 'Signing out…', disabled) while signing out", async () => {
    let resolveSignOut: () => void = () => {};
    mockSignOut.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveSignOut = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<NavSignOutButton />);

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    const button = screen.getByRole("button", { name: "Sign out" });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Signing out…");

    resolveSignOut();
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/login"));
  });

  it("signs out and redirects to /login on click", async () => {
    mockSignOut.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<NavSignOutButton />);

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => {
      expect(mockSignOut).toHaveBeenCalledTimes(1);
      expect(mockPush).toHaveBeenCalledWith("/login");
    });
  });
});
