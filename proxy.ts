import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  generateCsrfToken,
} from "@/lib/csrf";

const isProd = process.env.NODE_ENV === "production";

// Nonce-based CSP (Next's own guide,
// node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md):
// every page in this app is `force-dynamic` (auth-gated), so per-request
// nonces cost nothing extra in static-generation terms. This replaces the
// old `next.config.ts` static `script-src 'self'` header, which the ZAP
// PR13 comment claimed was safe because "the app has no inline `<script>`"
// — true of our own JSX, but Next.js itself always emits inline scripts
// (the `$RT` perf-timing script and `self.__next_f.push(...)` RSC hydration
// payloads), which that policy silently blocked, breaking hydration on
// every page. `'strict-dynamic'` lets those nonce'd framework scripts load
// their own dependents without listing every chunk by hash/origin.
function buildCspHeader(nonce: string): string {
  return `
    default-src 'self';
    script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isProd ? "" : " 'unsafe-eval'"};
    style-src 'self';
    img-src 'self' data:;
    font-src 'self';
    connect-src 'self';
    object-src 'none';
    base-uri 'self';
    form-action 'self';
    frame-ancestors 'none';
    ${isProd ? "upgrade-insecure-requests;" : ""}
  `
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ZAP PR13 fix (rule 10202): mints a fresh double-submit CSRF token on every
// `/login` view (this Next.js version renamed `middleware.ts` to `proxy.ts`,
// per node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md).
// Cookies can't be set during Server Component rendering (only in a Server
// Function or Route Handler), so the token is minted here: an HttpOnly
// cookie carries it back to the browser, and a forwarded request header lets
// `app/(auth)/login/page.tsx` read the same value via `headers()` to render
// into the form.
export function proxy(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const cspHeader = buildCspHeader(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", cspHeader);

  if (request.nextUrl.pathname === "/login") {
    const token = generateCsrfToken();
    requestHeaders.set(CSRF_HEADER_NAME, token);

    const response = NextResponse.next({
      request: { headers: requestHeaders },
    });
    response.headers.set("Content-Security-Policy", cspHeader);
    response.cookies.set(CSRF_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: isProd,
      path: "/",
    });

    return response;
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", cspHeader);

  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
