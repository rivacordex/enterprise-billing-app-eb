import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({
  getCurrentUserIdentity: vi.fn(),
}));
// um28: the layout now reads the collapse cookie + branding logo server-side.
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => undefined })),
}));
vi.mock("@/services/system-config/app-config-read.service", () => ({
  getBrandingLogo: vi.fn(async () => null),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/administration/users",
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

describe("AdminLayout sidebar footer", () => {
  it("renders the signed-in user's name and email in the footer", async () => {
    mockGetCurrentUserIdentity.mockResolvedValue({
      userName: "Ada Lovelace",
      userEmail: "ada@example.com",
    });

    render(await AdminLayout({ children: <main>content</main> }));

    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
  });

  it("truncates a long user name (truncate class present)", async () => {
    mockGetCurrentUserIdentity.mockResolvedValue({
      userName:
        "A Very Long User Name That Would Otherwise Overflow The Sidebar",
      userEmail: "averylongemailaddress.that.overflows@example.com",
    });

    render(await AdminLayout({ children: <main>content</main> }));

    const name = screen.getByText(/A Very Long User Name/);
    expect(name.className).toContain("truncate");
  });

  it("renders the sidebar sign-out button in the footer", async () => {
    mockGetCurrentUserIdentity.mockResolvedValue({
      userName: "Ada Lovelace",
      userEmail: "ada@example.com",
    });

    render(await AdminLayout({ children: <main>content</main> }));

    expect(
      screen.getByRole("button", { name: "Sign out" }),
    ).toBeInTheDocument();
  });

  it("still renders all four admin nav links", async () => {
    mockGetCurrentUserIdentity.mockResolvedValue({
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
  });

  it("omits the identity strip but keeps the sign-out button when no identity resolves", async () => {
    mockGetCurrentUserIdentity.mockResolvedValue(null);

    render(await AdminLayout({ children: <main>content</main> }));

    // um28 (admin-sidebar.tsx footer): the sign-out action ALWAYS renders so a
    // user can sign out even if the identity lookup fails; only the identity
    // strip (name + email) is gated on a resolved identity.
    expect(
      screen.getByRole("button", { name: "Sign out" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/@/)).not.toBeInTheDocument();
  });
});
