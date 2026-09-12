import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/administration/users",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/auth/client", () => ({
  authClient: { signOut: vi.fn() },
}));

import { AppShell } from "@/components/app-shell";

const IDENTITY = { userName: "Ada Lovelace", userEmail: "ada@example.com" };

function renderShell(defaultCollapsed: boolean) {
  render(
    <AppShell
      defaultCollapsed={defaultCollapsed}
      identity={IDENTITY}
      logo={null}
      appName="Acme Telco"
    >
      <main>page content</main>
    </AppShell>,
  );
}

beforeEach(() => {
  document.cookie = "sidebar_collapsed=; max-age=0; path=/";
});

describe("AppShell — owns collapse state + cookie (plan §3.4)", () => {
  it("seeds the sidebar width from defaultCollapsed and renders children", () => {
    renderShell(false);
    expect(screen.getByRole("complementary").className).toContain("w-64");
    expect(screen.getByText("page content")).toBeInTheDocument();
  });

  it("honors defaultCollapsed=true at first paint", () => {
    renderShell(true);
    expect(screen.getByRole("complementary").className).toContain("w-16");
  });

  it("collapses and writes the cookie to 1 on toggle", () => {
    renderShell(false);
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(screen.getByRole("complementary").className).toContain("w-16");
    expect(document.cookie).toContain("sidebar_collapsed=1");
  });

  it("expands and writes the cookie back to 0 from collapsed", () => {
    renderShell(true);
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(screen.getByRole("complementary").className).toContain("w-64");
    expect(document.cookie).toContain("sidebar_collapsed=0");
  });
});
