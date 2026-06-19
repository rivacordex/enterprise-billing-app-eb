import { z } from "zod";

export const setPasswordSchema = z
  .object({
    newPassword: z
      .string()
      .min(12, "Password must be at least 12 characters.")
      .max(128, "Password must be at most 128 characters."),
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });

export type SetPasswordInput = z.infer<typeof setPasswordSchema>;
