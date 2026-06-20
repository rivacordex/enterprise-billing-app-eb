import { and, eq, inArray } from "drizzle-orm";

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

  // Single-role variant of `findGrantsByRoleIds` above, for the Roles page
  // permission matrix (um18-spec §18.2.2).
  async findMappingsForRole(
    db: Database,
    roleId: string,
  ): Promise<
    Array<{ permissionName: PermissionName; permissionType: PermissionType }>
  > {
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
      .where(eq(rolePermissionAssign.refRoleId, roleId));

    return rows.map((row) => ({
      permissionName: assertPermissionName(row.permissionName),
      permissionType: row.permissionType as PermissionType,
    }));
  },

  // Multi-role variant of `findMappingsForRole` above, used by the Roles
  // page table (um18-spec §18.3) to avoid one query per role. Unlike
  // `findGrantsByRoleIds`, this keeps `roleId` on each row so the caller can
  // group mappings back by role.
  async findMappingsForRoles(
    db: Database,
    roleIds: string[],
  ): Promise<
    Array<{
      roleId: string;
      permissionName: PermissionName;
      permissionType: PermissionType;
    }>
  > {
    if (roleIds.length === 0) return [];

    const rows = await db
      .select({
        roleId: rolePermissionAssign.refRoleId,
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
      roleId: row.roleId,
      permissionName: assertPermissionName(row.permissionName),
      permissionType: row.permissionType as PermissionType,
    }));
  },

  // Upserts the (role, permission) → level mapping (um20-spec §20.2.2),
  // targeting the `role_permission_assign_role_permission_unique` constraint
  // so a role never carries more than one row per permission. No business
  // logic; no audit writes; accepts a transaction handle without opening
  // its own.
  async upsertRolePermission(
    db: Database,
    data: {
      roleId: string;
      permissionId: string;
      permissionType: PermissionType;
    },
  ): Promise<void> {
    await db
      .insert(rolePermissionAssign)
      .values({
        refRoleId: data.roleId,
        refPermissionId: data.permissionId,
        permissionType: data.permissionType,
      })
      .onConflictDoUpdate({
        target: [
          rolePermissionAssign.refRoleId,
          rolePermissionAssign.refPermissionId,
        ],
        set: {
          permissionType: data.permissionType,
          lastModifiedDatetime: new Date(),
        },
      });
  },

  // Removes a (role, permission) mapping — "no access" (um20-spec §20.2.2).
  // Idempotent: deleting a non-existent row completes without error.
  async deleteRolePermission(
    db: Database,
    data: { roleId: string; permissionId: string },
  ): Promise<void> {
    await db
      .delete(rolePermissionAssign)
      .where(
        and(
          eq(rolePermissionAssign.refRoleId, data.roleId),
          eq(rolePermissionAssign.refPermissionId, data.permissionId),
        ),
      );
  },

  // Removes every mapping for a role ahead of deleting the role row itself
  // (um21-spec §21.3.2, FK order). Idempotent: a role with no mappings
  // completes without error.
  async deleteMappingsForRole(db: Database, roleId: string): Promise<void> {
    await db
      .delete(rolePermissionAssign)
      .where(eq(rolePermissionAssign.refRoleId, roleId));
  },
};
