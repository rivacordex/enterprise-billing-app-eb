import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq } from "drizzle-orm";

import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import { roles } from "@/db/schema/roles";
import { permissions } from "@/db/schema/permissions";
import { rolePermissionAssign } from "@/db/schema/role-permission-assign";
import { systemConfig } from "@/db/schema/system-config";

const CONFIG_GROUP = "customer";
const CONFIG_KEY = "CUSTOMER_SEARCH_RESULT_LIMIT";

// Standalone script (`npm run db:seed-customer`) — never imported by
// application code. Depends on `seed-rbac.ts` having already run (the
// MANAGER/USER/ADMIN roles must exist for the customers:EDIT/READ grants,
// cm01-spec Design #7). Idempotent: checks for existing rows before each
// insert; everything happens inside one transaction.
async function main(): Promise<void> {
  const sql = postgres(config.DATABASE_URL, { max: 1 });
  const db = drizzle(sql, {
    schema: { roles, permissions, rolePermissionAssign, systemConfig },
  });

  try {
    await db.transaction(async (tx) => {
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
            "Max rows returned by a Customer search before the refine-search hint shows.",
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

      const [customersPermission] = await tx
        .select({ permissionId: permissions.permissionId })
        .from(permissions)
        .where(eq(permissions.permissionName, "customers"))
        .limit(1);

      if (!customersPermission) {
        throw new Error(
          "customers permission not found. Run db:migrate first.",
        );
      }

      // ADMIN gets EDIT, not DELETE — no DELETE level exists for `customers`
      // (architecture §4); EDIT is the highest level any role holds for it.
      // Mirrors Product Management's ADMIN grant (`pm02`) so an admin has
      // working access to every business module out of the box, not just
      // the platform-admin modules. Retroactive addition, post-`cm08` — the
      // original design granted only MANAGER/USER.
      const grants: { roleId: string; permissionType: "EDIT" | "READ" }[] = [
        { roleId: managerRole.roleId, permissionType: "EDIT" },
        { roleId: userRole.roleId, permissionType: "READ" },
        { roleId: adminRole.roleId, permissionType: "EDIT" },
      ];

      for (const grant of grants) {
        const [existingGrant] = await tx
          .select({ rolePermissionId: rolePermissionAssign.rolePermissionId })
          .from(rolePermissionAssign)
          .where(
            and(
              eq(rolePermissionAssign.refRoleId, grant.roleId),
              eq(
                rolePermissionAssign.refPermissionId,
                customersPermission.permissionId,
              ),
            ),
          )
          .limit(1);

        if (!existingGrant) {
          await tx.insert(rolePermissionAssign).values({
            refRoleId: grant.roleId,
            refPermissionId: customersPermission.permissionId,
            permissionType: grant.permissionType,
          });
        }
      }
    });

    logger.info("Customer module seeded successfully.");
  } finally {
    await sql.end();
  }
}

void main().catch((err: unknown) => {
  logger.error("Customer seed failed.", {
    message: err instanceof Error ? err.message : "Unknown error",
  });
  process.exit(1);
});
