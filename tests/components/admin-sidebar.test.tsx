import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/administration/users",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/auth/client", () => ({
  authClient: { signOut: vi.fn() },
}));

import { AdminSidebar } from "@/components/admin-sidebar";

const IDENTITY = { userName: "Ada Lovelace", userEmail: "ada@example.com" };

beforeEach(() => {
  // Clear the collapse cookie between tests.
  document.cookie = "sidebar_collapsed=; max-age=0; path=/";
});

describe("AdminSidebar — collapse toggle", () => {
  it("starts expanded (w-64) with aria-expanded=true and the identity strip", () => {
    render(
      <AdminSidebar defaultCollapsed={false} identity={IDENTITY} logo={null} />,
    );

    expect(screen.getByRole("complementary").className).toContain("w-64");
    const toggle = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
  });

  it("collapses to w-16, flips aria-expanded/label, and writes the cookie on toggle", () => {
    render(
      <AdminSidebar defaultCollapsed={false} identity={IDENTITY} logo={null} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));

    expect(screen.getByRole("complementary").className).toContain("w-16");
    const toggle = screen.getByRole("button", { name: "Expand sidebar" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.cookie).toContain("sidebar_collapsed=1");
  });

  it("honors defaultCollapsed=true (first paint collapsed, no identity strip)", () => {
    render(<AdminSidebar defaultCollapsed identity={IDENTITY} logo={null} />);

    expect(screen.getByRole("complementary").className).toContain("w-16");
    expect(
      screen.getByRole("button", { name: "Expand sidebar" }),
    ).toBeInTheDocument();
    // Collapsed rail drops the identity strip but keeps the sign-out control.
    expect(screen.queryByText("ada@example.com")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sign out" }),
    ).toBeInTheDocument();
  });

  it("writes the cookie back to 0 when expanding from collapsed", () => {
    render(<AdminSidebar defaultCollapsed identity={IDENTITY} logo={null} />);

    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));

    expect(document.cookie).toContain("sidebar_collapsed=0");
  });
});
