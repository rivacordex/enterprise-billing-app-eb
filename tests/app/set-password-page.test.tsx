import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/auth/guard", () => ({
  resolveForcePasswordChangeSession: vi
    .fn()
    .mockResolvedValue({ status: "PENDING" }),
}));
// The page now resolves the app name server-side; mock it so importing the
// page never reaches `db/client` (and `lib/config`'s eager env validation).
vi.mock("@/services/system-config/app-config-read.service", () => ({
  getAppName: vi.fn().mockResolvedValue("Acme Telco"),
}));
// Avoid `lib/config`'s eager env validation and a real password-policy shape.
vi.mock("@/lib/config", () => ({ passwordPolicy: {} }));
vi.mock("@/lib/formatters", () => ({
  formatPasswordPolicyHints: vi.fn().mockReturnValue([]),
}));
// Stub the interactive children (they call `useRouter`/`authClient`), keeping
// this test scoped to the page's own wordmark rendering.
vi.mock("@/components/auth/set-password-form", () => ({
  SetPasswordForm: () => <div data-testid="set-password-form" />,
}));
vi.mock("@/components/sign-out-button", () => ({
  SignOutButton: () => <button type="button">Sign out</button>,
}));

import SetPasswordPage, {
  generateMetadata,
} from "@/app/(auth)/set-password/page";

describe("SetPasswordPage", () => {
  it("renders the resolved app_name in the wordmark", async () => {
    render(await SetPasswordPage());

    expect(screen.getByText("Acme Telco")).toBeInTheDocument();
  });

  it("renders the set-your-password heading", async () => {
    render(await SetPasswordPage());

    expect(
      screen.getByRole("heading", { name: "Set your password" }),
    ).toBeInTheDocument();
  });

  it("folds the resolved app_name into the tab title", async () => {
    const metadata = await generateMetadata();

    expect(metadata.title).toBe("Set Password — Acme Telco");
  });
});
