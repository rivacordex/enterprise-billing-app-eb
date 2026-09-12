import { describe, expect, it } from "vitest";

import { resolveRootRedirect } from "@/lib/root-redirect";

describe("resolveRootRedirect", () => {
  it("redirects to /login when there is no session", () => {
    expect(resolveRootRedirect(null)).toBe("/login");
  });

  it("redirects to /set-password when force_password_change is true", () => {
    expect(resolveRootRedirect({ forcePasswordChange: true })).toBe(
      "/set-password",
    );
  });

  it("returns null (render the Homepage) for an ACTIVE user with no forced change", () => {
    // D3: the permission-ordered table and the /no-access fallback are retired
    // — a user with no grants now lands on the Homepage's empty state, not a
    // redirect.
    expect(resolveRootRedirect({ forcePasswordChange: false })).toBeNull();
  });
});
