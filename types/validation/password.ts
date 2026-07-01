import { z } from "zod";

import type { PasswordPolicy } from "@/types/password";

// um25-spec §"Policy source". The hardcoded default LOCAL password policy, kept
// in sync with lib/config.ts's schema defaults. `validation/**` is
// client-importable, so it must NOT import lib/config (server-only — it
// validates env at module load and would crash client bundles). The server
// threads the real, env-derived policy through explicitly via
// `buildSetPasswordSchema(passwordPolicy)`; this constant is the client-safe
// fallback that builds `defaultPasswordSchema`.
export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 15,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSpecial: true,
  specialChars: `!@#$%^&*()_+-=[]{}|;':\\",./<>?`,
};

// Escapes the chars that are special inside a `[...]` regex character class
// (`\`, `]`, `^`, `-`); every other character is safe to drop in as-is.
function escapeForCharacterClass(chars: string): string {
  return chars.replace(/[\\\]^-]/g, "\\$&");
}

// um25-spec §"Validation shape". Single source of truth for the LOCAL
// password complexity rules — built from a `PasswordPolicy` so the same
// factory produces both `defaultPasswordSchema` (the app-level policy) and
// any custom-policy schema a test wants to exercise. Uses one `superRefine`
// pass so every failing rule is reported in a single `.safeParse()` call,
// not just the first (the UI renders all of them simultaneously).
export function buildPasswordSchema(policy: PasswordPolicy) {
  const specialCharRegex = new RegExp(
    `[${escapeForCharacterClass(policy.specialChars)}]`,
  );

  return (
    z
      .string()
      .min(
        policy.minLength,
        `Password must be at least ${policy.minLength} characters.`,
      )
      // Upper bound on the password change input. In Zod v4 here a base-string
      // length failure does not abort the chained `.superRefine` (verified for
      // `.min` in um25), so an over-long value still surfaces every complexity
      // violation alongside this one.
      .max(128, "Password must be at most 128 characters.")
      .superRefine((value, ctx) => {
        if (policy.requireUppercase && !/[A-Z]/.test(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Password must contain at least one uppercase letter.",
          });
        }
        if (policy.requireLowercase && !/[a-z]/.test(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Password must contain at least one lowercase letter.",
          });
        }
        if (policy.requireNumber && !/[0-9]/.test(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Password must contain at least one number.",
          });
        }
        if (policy.requireSpecial && !specialCharRegex.test(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Password must contain at least one special character (${policy.specialChars}).`,
          });
        }
      })
  );
}

// Default-policy schema for tests and default validation. The server builds
// its authoritative schema from the env-derived policy via
// `buildSetPasswordSchema(passwordPolicy)` (set-password.schema.ts +
// set-password.action.ts), so this module never needs lib/config.
export const defaultPasswordSchema = buildPasswordSchema(
  DEFAULT_PASSWORD_POLICY,
);
