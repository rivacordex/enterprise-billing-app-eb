import { z } from "zod";

import { defaultPasswordSchema } from "@/validation/password";

export const setPasswordSchema = z
  .object({
    newPassword: defaultPasswordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });

export type SetPasswordInput = z.infer<typeof setPasswordSchema>;
