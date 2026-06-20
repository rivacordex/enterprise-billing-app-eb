import { z } from "zod";

export const createRoleSchema = z.object({
  roleName: z
    .string()
    .trim()
    .min(1, "Role name is required")
    .max(100, "Role name must be 100 characters or fewer"),
  roleDescr: z
    .string()
    .max(500, "Description must be 500 characters or fewer")
    .trim()
    .nullish()
    .transform((v) => v || null),
});

export type CreateRoleInput = z.infer<typeof createRoleSchema>;
