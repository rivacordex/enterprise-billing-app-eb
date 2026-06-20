import { z } from "zod";

export const resetPasswordSchema = z.object({
  userId: z.string().uuid("Invalid user ID"),
});

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
