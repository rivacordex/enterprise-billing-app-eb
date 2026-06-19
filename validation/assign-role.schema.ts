import { z } from "zod";

export const assignRoleSchema = z.object({
  userId: z.string().uuid("Invalid user ID"),
  roleId: z.string().uuid("Invalid role ID"),
});

export type AssignRoleInput = z.infer<typeof assignRoleSchema>;
