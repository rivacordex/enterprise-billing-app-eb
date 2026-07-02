// Sign-in error codes shared between the `auth/` server hook (throws them)
// and `components/login-form.tsx` (maps them to the three user-facing
// messages, um03-spec §2.1) — living in `types/` because `components/`
// cannot import the server-only `auth/index.ts`.
export const AUTH_ERROR_CODES = {
  USER_NOT_ACTIVE: "USER_NOT_ACTIVE",
  USER_LOCKED: "USER_LOCKED",
  // ZAP PR13 fix (rule 10202) — thrown by `auth/index.ts`'s sign-in hook
  // when the double-submit CSRF token (proxy.ts) doesn't match the cookie.
  INVALID_CSRF_TOKEN: "INVALID_CSRF_TOKEN",
} as const;

export type AuthErrorCode =
  (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];
