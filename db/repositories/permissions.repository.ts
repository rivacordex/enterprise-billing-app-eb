import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { permissions } from "@/db/schema/permissions";
import type { Permission, PermissionName } from "@/types/rbac";

export const permissionsRepository = {
  // Resolves a `permission_name` to its row (and `permission_id`) so the
  // write service can target `role_permission_assign` without embedding raw
  // SQL (um20-spec §20.2.1). Read-only; no audit writes.
  async findByName(
    db: Database,
    name: PermissionName,
  ): Promise<Permission | null> {
    const [row] = await db
      .select()
      .from(permissions)
      .where(eq(permissions.permissionName, name))
      .limit(1);
    return row ?? null;
  },
};
