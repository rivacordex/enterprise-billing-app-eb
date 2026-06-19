import { z } from "zod";

export const disableUserSchema = z.object({
  userId: z.string().uuid("Invalid user ID"),
});

export type DisableUserInput = z.infer<typeof disableUserSchema>;
