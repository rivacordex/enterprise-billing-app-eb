import { z } from "zod";

export const deleteUserSchema = z.object({
  userId: z.string().uuid("Invalid user ID"),
});

export type DeleteUserInput = z.infer<typeof deleteUserSchema>;
