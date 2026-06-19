import { eq, inArray } from "drizzle-orm";

import type { Database } from "@/db/client";
import { rolePermissionAssign } from "@/db/schema/role-permission-assign";
import { permissions } from "@/db/schema/permissions";
import { internal } from "@/lib/errors";
import { PERMISSION_NAMES } from "@/types/rbac";
import type { PermissionName, PermissionType } from "@/types/rbac";

function assertPermissionName(value: string): PermissionName {
  if (!(PERMISSION_NAMES as readonly string[]).includes(value)) {
    throw internal(
      `Unrecognised permission_name '${value}' returned from core.permissions — likely a migration/seed bug.`,
    );
  }
  return value as PermissionName;
}

export const rolePermissionAssignRepository = {
  async findGrantsByRoleIds(
    db: Database,
    roleIds: string[],
  ): Promise<
    Array<{ permissionName: PermissionName; permissionType: PermissionType }>
  > {
    if (roleIds.length === 0) return [];

    const rows = await db
      .select({
        permissionName: permissions.permissionName,
        permissionType: rolePermissionAssign.permissionType,
      })
      .from(rolePermissionAssign)
      .innerJoin(
        permissions,
        eq(permissions.permissionId, rolePermissionAssign.refPermissionId),
      )
      .where(inArray(rolePermissionAssign.refRoleId, roleIds));

    return rows.map((row) => ({
      permissionName: assertPermissionName(row.permissionName),
      permissionType: row.permissionType as PermissionType,
    }));
  },
};
