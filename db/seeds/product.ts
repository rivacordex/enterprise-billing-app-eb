import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, and } from "drizzle-orm";

import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import { roles } from "@/db/schema/roles";
import { permissions } from "@/db/schema/permissions";
import { rolePermissionAssign } from "@/db/schema/role-permission-assign";

// Standalone script (`npm run db:seed-product`) — never imported by
// application code. Depends on `seed-rbac.ts` having already run (the ADMIN
// role must exist for the products:DELETE grant, pm02-spec Design #7) and on
// `db:migrate` (the `products` permission row). Idempotent: the grant is
// inserted only when absent; the whole seed is one transaction.
//
// This is the mandatory remainder of the former mixed product seed. The demo
// offering/spec/price catalog it used to carry (the `Demo — *` rows) moved to
// the opt-in, prod-guarded `db:seed-demo` (`db/seeds/demo/`), so `db:setup`
// seeds zero demo rows — only this grant.
async function main(): Promise<void> {
  const sql = postgres(config.DATABASE_URL, { max: 1 });
  const db = drizzle(sql, {
    schema: {
      roles,
      permissions,
      rolePermissionAssign,
    },
  });

  try {
    await db.transaction(async (tx) => {
      const [adminRole] = await tx
        .select({ roleId: roles.roleId })
        .from(roles)
        .where(eq(roles.roleName, "ADMIN"))
        .limit(1);

      if (!adminRole) {
        throw new Error("ADMIN role not found. Run db:seed-rbac first.");
      }

      const [productsPermission] = await tx
        .select({ permissionId: permissions.permissionId })
        .from(permissions)
        .where(eq(permissions.permissionName, "products"))
        .limit(1);

      if (!productsPermission) {
        throw new Error("products permission not found. Run db:migrate first.");
      }

      const [existingGrant] = await tx
        .select({ rolePermissionId: rolePermissionAssign.rolePermissionId })
        .from(rolePermissionAssign)
        .where(
          and(
            eq(rolePermissionAssign.refRoleId, adminRole.roleId),
            eq(
              rolePermissionAssign.refPermissionId,
              productsPermission.permissionId,
            ),
          ),
        )
        .limit(1);

      if (!existingGrant) {
        await tx.insert(rolePermissionAssign).values({
          refRoleId: adminRole.roleId,
          refPermissionId: productsPermission.permissionId,
          permissionType: "DELETE",
        });
      }
    });

    logger.info("Product permissions seeded successfully.");
  } finally {
    await sql.end();
  }
}

void main().catch((err: unknown) => {
  logger.error("Product seed failed.", {
    message: err instanceof Error ? err.message : "Unknown error",
  });
  process.exit(1);
});
