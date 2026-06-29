import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({
  auth: { api: { getSession: vi.fn().mockResolvedValue(null) } },
}));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));
// `LoginForm` (rendered unconditionally by the page) calls `useRouter()` —
// real app-router context isn't mounted under jsdom, mirroring
// tests/app/no-access-page.test.tsx's precedent.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

let mockIsSsoConfigured = false;
vi.mock("@/lib/config", () => ({
  get isSsoConfigured() {
    return mockIsSsoConfigured;
  },
}));
// um28: the login page now resolves the branding logo server-side; mock it so
// importing the page never reaches `db/client` (and `lib/config`'s eager env
// validation).
vi.mock("@/services/system-config/app-config-read.service", () => ({
  getBrandingLogo: vi.fn().mockResolvedValue(null),
}));

import LoginPage from "@/app/(auth)/login/page";

describe("LoginPage", () => {
  it("hides the Microsoft button and divider when SSO is not configured", async () => {
    mockIsSsoConfigured = false;

    render(await LoginPage({ searchParams: Promise.resolve({}) }));

    expect(
      screen.queryByRole("link", { name: /sign in with microsoft/i }),
    ).toBeNull();
  });

  it("renders the Microsoft sign-in link when SSO is configured", async () => {
    mockIsSsoConfigured = true;

    render(await LoginPage({ searchParams: Promise.resolve({}) }));

    const link = screen.getByRole("link", { name: /sign in with microsoft/i });
    expect(link).toHaveAttribute("href", "/api/auth/signin/microsoft");
  });

  it("renders the not-authorized alert for every known SSO rejection code", async () => {
    for (const error of [
      "sso_no_account",
      "signup_disabled",
      "unable_to_link_account",
      "account_not_linked",
    ]) {
      const { unmount } = render(
        await LoginPage({ searchParams: Promise.resolve({ error }) }),
      );
      expect(screen.getByText(/not authorized to access/i)).toBeInTheDocument();
      unmount();
    }
  });

  it("renders the generic failure alert for an unrecognized error code", async () => {
    render(
      await LoginPage({
        searchParams: Promise.resolve({ error: "something_else" }),
      }),
    );

    expect(screen.getByText(/sign-in failed/i)).toBeInTheDocument();
  });

  it("renders no alert when no error param is present", async () => {
    render(await LoginPage({ searchParams: Promise.resolve({}) }));

    expect(screen.queryByRole("alert")).toBeNull();
  });
});
