import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/administration/users",
  useSearchParams: () => new URLSearchParams(),
}));

import { AdminSidebar } from "@/components/admin-sidebar";

// After the top-bar move (plan §3.6) the sidebar is controlled + nav-only: it
// owns no state, toggle, identity strip, or brand. All that remains to assert
// is the <aside> width reacting to the `collapsed` prop. The toggle/cookie and
// identity cases moved to app-topbar.test.tsx / app-shell.test.tsx.
describe("AdminSidebar — controlled width", () => {
  it("renders w-64 when expanded", () => {
    render(<AdminSidebar collapsed={false} />);
    expect(screen.getByRole("complementary").className).toContain("w-64");
  });

  it("renders w-16 when collapsed", () => {
    render(<AdminSidebar collapsed />);
    expect(screen.getByRole("complementary").className).toContain("w-16");
  });
});
