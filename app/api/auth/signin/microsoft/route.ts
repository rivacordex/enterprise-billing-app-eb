import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { config } from "@/lib/config";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

// um10-spec §10.7 wants a plain `<a href="/api/auth/signin/microsoft">` —
// a full top-level GET navigation, not a fetch/client-side redirect. The
// installed Better-Auth version has no such auto-registered GET route; it
// only exposes `POST /sign-in/social` (JSON body, consumed by its client
// SDK via `window.location`, not an HTTP redirect). This Route Handler
// bridges that gap: it calls the same endpoint server-side and turns its
// JSON `{ url }` response into a real 307, forwarding the OAuth state
// cookie Better-Auth sets while building the authorization URL — without
// that cookie, the `/callback/microsoft` request can't validate its state
// param.
export async function GET(): Promise<Response> {
  let response: Response;
  try {
    response = await auth.api.signInSocial({
      body: { provider: "microsoft", callbackURL: "/" },
      headers: await headers(),
      asResponse: true,
    });
  } catch (err) {
    logger.error("Failed to start Microsoft sign-in.", {
      message: err instanceof Error ? err.message : "Unknown error",
    });
    return NextResponse.redirect(
      new URL("/login?error=sso_unavailable", config.APP_URL),
    );
  }

  const { url } = (await response.json()) as { url?: string };
  if (!url) {
    logger.error("Microsoft sign-in did not return an authorization URL.");
    return NextResponse.redirect(
      new URL("/login?error=sso_unavailable", config.APP_URL),
    );
  }

  const redirectResponse = NextResponse.redirect(url, 307);
  for (const cookie of response.headers.getSetCookie()) {
    redirectResponse.headers.append("set-cookie", cookie);
  }
  return redirectResponse;
}
