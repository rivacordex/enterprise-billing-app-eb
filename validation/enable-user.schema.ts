import { z } from "zod";

export const enableUserSchema = z.object({
  userId: z.string().uuid("Invalid user ID"),
});

export type EnableUserInput = z.infer<typeof enableUserSchema>;
