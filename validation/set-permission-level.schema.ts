import { z } from "zod";

import { PERMISSION_NAMES, PERMISSION_TYPES } from "@/types/rbac";

export const setPermissionLevelSchema = z.object({
  roleId: z.string().uuid("Invalid role ID"),
  permissionName: z.enum(PERMISSION_NAMES),
  level: z.enum(PERMISSION_TYPES).nullable(),
});

export type SetPermissionLevelInput = z.infer<typeof setPermissionLevelSchema>;
