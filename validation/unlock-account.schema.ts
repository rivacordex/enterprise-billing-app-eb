import { z } from "zod";

export const unlockAccountSchema = z.object({
  userId: z.string().uuid("Invalid user ID"),
});

export type UnlockAccountInput = z.infer<typeof unlockAccountSchema>;
