import { z } from "zod";

export const deleteRoleSchema = z.object({
  roleId: z.string().uuid("Invalid role ID"),
});

export type DeleteRoleInput = z.infer<typeof deleteRoleSchema>;
