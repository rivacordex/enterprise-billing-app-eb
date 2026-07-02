import "server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";

// ZAP PR13 fix (rule 10202, context/zap-reports/ZAP-PR13-fix-plan.md):
// double-submit token for the LOCAL sign-in form. `proxy.ts` mints the token
// and sets it as an HttpOnly cookie on every `/login` view, forwarding the
// same value as a request header so `app/(auth)/login/page.tsx` can render
// it into a hidden field (satisfies ZAP's form-token check) and
// `components/login-form.tsx` can resend it as a header on submit.
// `auth/index.ts`'s sign-in hook compares the two.
//
// The cookie/header names and `readCookieValue` live in lib/csrf-shared.ts
// (client-importable, no node:crypto) — re-exported here so existing
// server-side callers don't need two import lines. Client components must
// import those names from lib/csrf-shared directly, never from this file.
export {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  readCookieValue,
} from "./csrf-shared";

export function generateCsrfToken(): string {
  return randomBytes(32).toString("hex");
}

export function csrfTokensMatch(
  submitted: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!submitted || !expected || submitted.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(submitted), Buffer.from(expected));
}
