import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const DEFAULT_PATHNAME = "/administration/users";
let mockPathname = DEFAULT_PATHNAME;
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/auth/client", () => ({
  authClient: { signOut: vi.fn() },
}));

import { AppTopBar } from "@/components/app-topbar";

// Reset the shared mutable pathname after every test so a case that sets it
// (e.g. the Homepage aria-current test) can't leak "/" into later tests even if
// it throws before an inline reset.
afterEach(() => {
  mockPathname = DEFAULT_PATHNAME;
});

const IDENTITY = { userName: "Ada Lovelace", userEmail: "ada@example.com" };

function renderTopBar(
  overrides: Partial<React.ComponentProps<typeof AppTopBar>> = {},
) {
  const props: React.ComponentProps<typeof AppTopBar> = {
    collapsed: false,
    onToggle: vi.fn(),
    identity: IDENTITY,
    logo: null,
    appName: "Acme Telco",
    ...overrides,
  };
  render(<AppTopBar {...props} />);
  return props;
}

describe("AppTopBar", () => {
  it("renders the brand wordmark (app name) and a Home affordance", () => {
    renderTopBar();
    expect(screen.getByText("Acme Telco")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute(
      "href",
      "/",
    );
  });

  it("renders the identity line as name and email (D11)", () => {
    renderTopBar();
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
  });

  it("renders the sign-out control", () => {
    renderTopBar();
    expect(
      screen.getByRole("button", { name: "Sign out" }),
    ).toBeInTheDocument();
  });

  it("marks Home aria-current=page only on the Homepage route", () => {
    mockPathname = "/";
    renderTopBar();
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // Reset handled by afterEach.
  });

  it("exposes the collapse toggle with aria-expanded reflecting state and calls onToggle", () => {
    const { onToggle } = renderTopBar({ collapsed: false });
    const toggle = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("flips the toggle label + aria-expanded when collapsed", () => {
    renderTopBar({ collapsed: true });
    const toggle = screen.getByRole("button", { name: "Expand sidebar" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});
