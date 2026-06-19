import { z } from "zod";

export const revokeRoleSchema = z.object({
  userId: z.string().uuid("Invalid user ID"),
  roleId: z.string().uuid("Invalid role ID"),
});

export type RevokeRoleInput = z.infer<typeof revokeRoleSchema>;
