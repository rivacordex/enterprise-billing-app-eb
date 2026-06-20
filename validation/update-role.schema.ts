import { z } from "zod";

export const updateRoleSchema = z.object({
  roleId: z.string().uuid("Invalid role ID"),
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

export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;

// `RoleForm`'s edit mode (um19-spec §19.5) renders only the editable fields
// — `roleId` is injected by `RoleDetail` from the selected role, not
// entered by the user — so its resolver validates this derived schema
// rather than the full action-boundary schema above. Mirrors
// `editUserDetailsFieldsSchema` (validation/update-user-details.schema.ts).
export const editRoleFieldsSchema = updateRoleSchema.omit({ roleId: true });

export type EditRoleFields = z.infer<typeof editRoleFieldsSchema>;
