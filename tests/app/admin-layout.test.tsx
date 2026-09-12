import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The layout resolves the full permission map (via the request-scoped
// getEffectivePermissions wrapper) whenever an identity resolves, to thread
// AdminNav's show/hide state. Grant across several modules — not just
// Administration — so the test can catch a registry→nav regression for any
// section, not only the admin one.
vi.mock("@/auth/guard", () => ({
  getCurrentUserIdentity: vi.fn(),
  getEffectivePermissions: vi.fn(async () => ({
    users: "READ",
    roles: "READ",
    system_config: "READ",
    audit_log: "READ",
    products: "READ",
    customers: "READ",
    accounts_view: "READ",
    billrun_view: "READ",
  })),
}));
// The layout reads the collapse cookie + branding logo server-side.
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => undefined })),
}));
vi.mock("@/services/system-config/app-config-read.service", () => ({
  getBrandingLogo: vi.fn(async () => null),
  getAppName: vi.fn(async () => "Acme Telco"),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/administration/users",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/auth/client", () => ({
  authClient: { signOut: vi.fn() },
}));
vi.mock("@/components/ui/sonner", () => ({
  Toaster: () => null,
}));

import AdminLayout from "@/app/(app)/layout";
import { getCurrentUserIdentity } from "@/auth/guard";

const mockGetCurrentUserIdentity = vi.mocked(getCurrentUserIdentity);

beforeEach(() => {
  mockGetCurrentUserIdentity.mockReset();
});

describe("AdminLayout — top-bar identity", () => {
  it("renders the signed-in user's name and email in the top bar", async () => {
    mockGetCurrentUserIdentity.mockResolvedValue({
      userId: "user-1",
      userName: "Ada Lovelace",
      userEmail: "ada@example.com",
    });

    render(await AdminLayout({ children: <main>content</main> }));

    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
  });

  it("truncates a long user name (truncate class present)", async () => {
    mockGetCurrentUserIdentity.mockResolvedValue({
      userId: "user-1",
      userName:
        "A Very Long User Name That Would Otherwise Overflow The Top Bar",
      userEmail: "averylongemailaddress.that.overflows@example.com",
    });

    render(await AdminLayout({ children: <main>content</main> }));

    const name = screen.getByText(/A Very Long User Name/);
    expect(name.className).toContain("truncate");
  });

  it("renders the sign-out button in the top bar", async () => {
    mockGetCurrentUserIdentity.mockResolvedValue({
      userId: "user-1",
      userName: "Ada Lovelace",
      userEmail: "ada@example.com",
    });

    render(await AdminLayout({ children: <main>content</main> }));

    expect(
      screen.getByRole("button", { name: "Sign out" }),
    ).toBeInTheDocument();
  });

  it("renders the permitted admin nav links (permission-scoped)", async () => {
    mockGetCurrentUserIdentity.mockResolvedValue({
      userId: "user-1",
      userName: "Ada Lovelace",
      userEmail: "ada@example.com",
    });

    render(await AdminLayout({ children: <main>content</main> }));

    expect(screen.getByRole("link", { name: "Users" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Roles" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "System Configuration" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Audit Log" })).toBeInTheDocument();
    // A non-Administration section also renders from the registry, so a
    // registry→nav regression outside admin is caught too.
    expect(
      screen.getByRole("link", { name: "View Product" }),
    ).toBeInTheDocument();
  });

  it("omits the identity strip but keeps the sign-out button when no identity resolves", async () => {
    mockGetCurrentUserIdentity.mockResolvedValue(null);

    render(await AdminLayout({ children: <main>content</main> }));

    // The sign-out action always renders; only the identity strip depends on a
    // resolved identity. With no identity the nav also fails closed (D6).
    expect(
      screen.getByRole("button", { name: "Sign out" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/@/)).not.toBeInTheDocument();
  });
});
