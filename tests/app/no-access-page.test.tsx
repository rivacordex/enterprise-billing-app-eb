import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({
  requireAuthenticated: vi
    .fn()
    .mockResolvedValue({ userId: "user-1", userEmail: "user-1@example.com" }),
}));
vi.mock("@/auth/client", () => ({
  authClient: { signOut: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import NoAccessPage from "@/app/(admin)/no-access/page";
import { requireAuthenticated } from "@/auth/guard";

describe("NoAccessPage", () => {
  it("calls requireAuthenticated at the top", async () => {
    await NoAccessPage();
    expect(requireAuthenticated).toHaveBeenCalled();
  });

  it("renders the No Access heading and body copy", async () => {
    render(await NoAccessPage());

    expect(
      screen.getByRole("heading", { name: "No Access" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/doesn.t have access to any modules yet/i),
    ).toBeInTheDocument();
  });

  it("renders a focusable sign-out control and no admin navigation", async () => {
    render(await NoAccessPage());

    const signOutButton = screen.getByRole("button", { name: /sign out/i });
    expect(signOutButton).toBeInTheDocument();
    expect(signOutButton.tagName).toBe("BUTTON");

    expect(document.querySelector("nav")).toBeNull();
    expect(document.querySelector('a[href^="/administration"]')).toBeNull();
  });
});
