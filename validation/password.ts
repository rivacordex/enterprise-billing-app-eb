import { z } from "zod";

import { passwordPolicy } from "@/lib/password-policy";
import type { PasswordPolicy } from "@/types/password";

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

// The app-level schema action schemas import — built from `passwordPolicy`
// (`lib/config.ts`).
export const defaultPasswordSchema = buildPasswordSchema(passwordPolicy);
