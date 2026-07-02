import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  generateCsrfToken,
} from "@/lib/csrf";

// `auth/index.ts`'s `/sign-in/email` hook (ZAP PR13 fix) reads the
// double-submit CSRF pair off `ctx.request`, which better-auth only
// populates when a real `Request` is passed to `auth.api.signInEmail(...)`
// (see better-call's `createInternalContext`: `request: context?.request`).
// Integration tests call that API programmatically with no such request, so
// every sign-in attempt fails the CSRF check before password verification
// ever runs. This builds a `Request` with a matching cookie/header pair,
// mirroring what `proxy.ts` mints for a real `/login` form submission.
//
// Passing `request` also flips better-auth's own default for `asResponse`
// (`to-auth-endpoints.mjs`: `asResponse: context?.asResponse ??
// isRequestLike(context?.request)`), which would make `signInEmail` resolve
// a raw `Response` instead of throwing/returning the parsed result these
// tests assert on — `asResponse: false` below overrides that back.
export function csrfSignInOptions(): {
  request: Request;
  asResponse: false;
} {
  const token = generateCsrfToken();
  return {
    request: new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        cookie: `${CSRF_COOKIE_NAME}=${token}`,
        [CSRF_HEADER_NAME]: token,
      },
    }),
    asResponse: false,
  };
}
