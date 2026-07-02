import { z } from "zod";

import type { PasswordPolicy } from "@/types/password";
import {
  DEFAULT_PASSWORD_POLICY,
  buildPasswordSchema,
} from "@/validation/password";

// Factory: builds the set-password schema for a specific policy. The server
// (set-password.action.ts) calls this with the env-derived `passwordPolicy`;
// the client form calls it with the policy the page passes as a prop. Neither
// pulls lib/config into the client bundle.
export function buildSetPasswordSchema(policy: PasswordPolicy) {
  return z
    .object({
      newPassword: buildPasswordSchema(policy),
      confirmPassword: z.string(),
    })
    .refine((data) => data.newPassword === data.confirmPassword, {
      message: "Passwords do not match.",
      path: ["confirmPassword"],
    });
}

// Default-policy instance for tests and the input type.
export const setPasswordSchema = buildSetPasswordSchema(
  DEFAULT_PASSWORD_POLICY,
);

export type SetPasswordInput = z.infer<typeof setPasswordSchema>;
