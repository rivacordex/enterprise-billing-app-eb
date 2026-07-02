import { randomBytes, timingSafeEqual } from "node:crypto";

// ZAP PR13 fix (rule 10202, context/zap-reports/ZAP-PR13-fix-plan.md):
// double-submit token for the LOCAL sign-in form. `proxy.ts` mints the token
// and sets it as an HttpOnly cookie on every `/login` view, forwarding the
// same value as a request header so `app/(auth)/login/page.tsx` can render
// it into a hidden field (satisfies ZAP's form-token check) and
// `components/login-form.tsx` can resend it as a header on submit.
// `auth/index.ts`'s sign-in hook compares the two.
export const CSRF_COOKIE_NAME = "csrf_token";
export const CSRF_HEADER_NAME = "x-csrf-token";

export function generateCsrfToken(): string {
  return randomBytes(32).toString("hex");
}

export function readCookieValue(
  cookieHeader: string | null | undefined,
  name: string,
): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) continue;
    if (part.slice(0, separatorIndex).trim() !== name) continue;
    return decodeURIComponent(part.slice(separatorIndex + 1).trim());
  }
  return null;
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
