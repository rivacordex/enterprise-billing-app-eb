import { and, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { roles } from "@/db/schema/roles";
import { permissions } from "@/db/schema/permissions";
import { rolePermissionAssign } from "@/db/schema/role-permission-assign";
import { systemConfig } from "@/db/schema/system-config";

const CONFIG_GROUP = "accounts";
const CONFIG_KEY = "ACCOUNTS_SEARCH_RESULT_LIMIT";

async function grantPermission(
  tx: Database,
  permissionId: string,
  grants: { roleId: string; permissionType: "READ" | "EDIT" }[],
): Promise<void> {
  for (const grant of grants) {
    const [existing] = await tx
      .select({
        rolePermissionId: rolePermissionAssign.rolePermissionId,
        permissionType: rolePermissionAssign.permissionType,
      })
      .from(rolePermissionAssign)
      .where(
        and(
          eq(rolePermissionAssign.refRoleId, grant.roleId),
          eq(rolePermissionAssign.refPermissionId, permissionId),
        ),
      )
      .limit(1);

    if (!existing) {
      await tx.insert(rolePermissionAssign).values({
        refRoleId: grant.roleId,
        refPermissionId: permissionId,
        permissionType: grant.permissionType,
      });
    } else if (existing.permissionType !== grant.permissionType) {
      await tx
        .update(rolePermissionAssign)
        .set({ permissionType: grant.permissionType })
        .where(
          eq(rolePermissionAssign.rolePermissionId, existing.rolePermissionId),
        );
    }
  }
}

// Idempotent: checks for existing rows before every insert.
// Must be called inside the caller's transaction (tx).
export async function seedAccountsPermissions(tx: Database): Promise<void> {
  const [existingConfig] = await tx
    .select({ configId: systemConfig.configId })
    .from(systemConfig)
    .where(
      and(
        eq(systemConfig.configGroup, CONFIG_GROUP),
        eq(systemConfig.configKey, CONFIG_KEY),
      ),
    )
    .limit(1);

  if (!existingConfig) {
    await tx.insert(systemConfig).values({
      configGroup: CONFIG_GROUP,
      configVersion: 1,
      configKey: CONFIG_KEY,
      configValue: "5",
      description:
        "Max rows returned by an Accounts Overview search before the refine-search hint shows.",
      isSecret: false,
      status: "ACTIVE",
      modifiedBy: null,
    });
  }

  const [managerRole] = await tx
    .select({ roleId: roles.roleId })
    .from(roles)
    .where(eq(roles.roleName, "MANAGER"))
    .limit(1);
  const [userRole] = await tx
    .select({ roleId: roles.roleId })
    .from(roles)
    .where(eq(roles.roleName, "USER"))
    .limit(1);
  const [adminRole] = await tx
    .select({ roleId: roles.roleId })
    .from(roles)
    .where(eq(roles.roleName, "ADMIN"))
    .limit(1);

  if (!managerRole || !userRole || !adminRole) {
    throw new Error(
      "MANAGER/USER/ADMIN role not found. Run db:seed-rbac first.",
    );
  }

  const [accountsViewPermission] = await tx
    .select({ permissionId: permissions.permissionId })
    .from(permissions)
    .where(eq(permissions.permissionName, "accounts_view"))
    .limit(1);

  if (!accountsViewPermission) {
    throw new Error(
      "accounts_view permission not found. Run db:migrate first.",
    );
  }

  // accounts_view is read-only (ac05-spec §2.6) — MANAGER and USER both hold
  // READ; ADMIN gets READ so platform admins can audit the accounts surface.
  await grantPermission(tx, accountsViewPermission.permissionId, [
    { roleId: managerRole.roleId, permissionType: "READ" },
    { roleId: userRole.roleId, permissionType: "READ" },
    { roleId: adminRole.roleId, permissionType: "READ" },
  ]);

  const [accountsTransactionsPermission] = await tx
    .select({ permissionId: permissions.permissionId })
    .from(permissions)
    .where(eq(permissions.permissionName, "accounts_transactions"))
    .limit(1);

  if (!accountsTransactionsPermission) {
    throw new Error(
      "accounts_transactions permission not found. Run db:migrate first.",
    );
  }

  // accounts_transactions is EDIT for MANAGER, USER, and ADMIN (ac07-spec §2.6).
  await grantPermission(tx, accountsTransactionsPermission.permissionId, [
    { roleId: managerRole.roleId, permissionType: "EDIT" },
    { roleId: userRole.roleId, permissionType: "EDIT" },
    { roleId: adminRole.roleId, permissionType: "EDIT" },
  ]);

  const [accountsConfigPermission] = await tx
    .select({ permissionId: permissions.permissionId })
    .from(permissions)
    .where(eq(permissions.permissionName, "accounts_config"))
    .limit(1);

  if (!accountsConfigPermission) {
    throw new Error(
      "accounts_config permission not found. Run db:migrate first.",
    );
  }

  // accounts_config is finance-config only (ac12-spec §2.6, architecture §4)
  // — MANAGER and ADMIN hold EDIT; USER gets no accounts_config grant at all.
  await grantPermission(tx, accountsConfigPermission.permissionId, [
    { roleId: managerRole.roleId, permissionType: "EDIT" },
    { roleId: adminRole.roleId, permissionType: "EDIT" },
  ]);
}
