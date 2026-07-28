import { and, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { roles } from "@/db/schema/roles";
import { permissions } from "@/db/schema/permissions";
import { rolePermissionAssign } from "@/db/schema/role-permission-assign";
import { systemConfig } from "@/db/schema/system-config";

const CONFIG_GROUP = "accounts";
const CONFIG_KEY = "ACCOUNTS_SEARCH_RESULT_LIMIT";

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
  // No EDIT level for this permission (EDIT lives on accounts_transactions /
  // accounts_config).
  const grants: { roleId: string; permissionType: "READ" }[] = [
    { roleId: managerRole.roleId, permissionType: "READ" },
    { roleId: userRole.roleId, permissionType: "READ" },
    { roleId: adminRole.roleId, permissionType: "READ" },
  ];

  for (const grant of grants) {
    const [existing] = await tx
      .select({ rolePermissionId: rolePermissionAssign.rolePermissionId })
      .from(rolePermissionAssign)
      .where(
        and(
          eq(rolePermissionAssign.refRoleId, grant.roleId),
          eq(
            rolePermissionAssign.refPermissionId,
            accountsViewPermission.permissionId,
          ),
        ),
      )
      .limit(1);

    if (!existing) {
      await tx.insert(rolePermissionAssign).values({
        refRoleId: grant.roleId,
        refPermissionId: accountsViewPermission.permissionId,
        permissionType: grant.permissionType,
      });
    }
  }
}
