import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockSignInSocial = vi.hoisted(() => vi.fn());
vi.mock("@/auth", () => ({
  auth: { api: { signInSocial: mockSignInSocial } },
}));
// Avoids `lib/config.ts`'s eager env validation, which would otherwise
// require DATABASE_URL/BETTER_AUTH_SECRET/etc. in this DB-free unit suite.
vi.mock("@/lib/config", () => ({
  config: { APP_URL: "http://localhost:3000" },
}));

import { GET } from "@/app/api/auth/signin/microsoft/route";

describe("GET /api/auth/signin/microsoft", () => {
  it("redirects to the Entra authorization URL and forwards the state cookie", async () => {
    const authorizeUrl =
      "https://login.microsoftonline.com/tenant/authorize?x=1";
    mockSignInSocial.mockResolvedValue(
      new Response(JSON.stringify({ url: authorizeUrl, redirect: true }), {
        status: 200,
        headers: { "set-cookie": "better-auth.state=abc123; Path=/; HttpOnly" },
      }),
    );

    const response = await GET();

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(authorizeUrl);
    expect(response.headers.get("set-cookie")).toContain(
      "better-auth.state=abc123",
    );
  });

  it("falls back to a login error redirect when signInSocial throws", async () => {
    mockSignInSocial.mockRejectedValue(new Error("provider not found"));

    const response = await GET();

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain(
      "/login?error=sso_unavailable",
    );
  });

  it("falls back to a login error redirect when no URL is returned", async () => {
    mockSignInSocial.mockResolvedValue(
      new Response(JSON.stringify({ redirect: false }), { status: 200 }),
    );

    const response = await GET();

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain(
      "/login?error=sso_unavailable",
    );
  });
});
