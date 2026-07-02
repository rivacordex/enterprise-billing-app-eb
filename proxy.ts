import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  generateCsrfToken,
} from "@/lib/csrf";

// ZAP PR13 fix (rule 10202): mints a fresh double-submit CSRF token on every
// `/login` view (this Next.js version renamed `middleware.ts` to `proxy.ts`,
// per node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md).
// Cookies can't be set during Server Component rendering (only in a Server
// Function or Route Handler), so the token is minted here: an HttpOnly
// cookie carries it back to the browser, and a forwarded request header lets
// `app/(auth)/login/page.tsx` read the same value via `headers()` to render
// into the form.
export function proxy(request: NextRequest): NextResponse {
  const token = generateCsrfToken();

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(CSRF_HEADER_NAME, token);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.cookies.set(CSRF_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });

  return response;
}

export const config = {
  matcher: ["/login"],
};
