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
// `db:migrate` (the `products` and `ratecard` permission rows). Idempotent:
// each grant is inserted only when absent; the whole seed is one transaction.
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

      // G-RC3 — the `ratecard` grants migration 0043 defers to "the seed":
      // ADMIN/MANAGER : EDIT, USER : READ (no DELETE level exists for it).
      // Without them the Rate Card nav entry is hidden from every role.
      const [ratecardPermission] = await tx
        .select({ permissionId: permissions.permissionId })
        .from(permissions)
        .where(eq(permissions.permissionName, "ratecard"))
        .limit(1);

      if (!ratecardPermission) {
        throw new Error("ratecard permission not found. Run db:migrate first.");
      }

      const ratecardGrants: {
        roleName: string;
        permissionType: "READ" | "EDIT";
      }[] = [
        { roleName: "ADMIN", permissionType: "EDIT" },
        { roleName: "MANAGER", permissionType: "EDIT" },
        { roleName: "USER", permissionType: "READ" },
      ];

      for (const grant of ratecardGrants) {
        const [role] = await tx
          .select({ roleId: roles.roleId })
          .from(roles)
          .where(eq(roles.roleName, grant.roleName))
          .limit(1);

        if (!role) {
          throw new Error(
            `${grant.roleName} role not found. Run db:seed-rbac first.`,
          );
        }

        const [existing] = await tx
          .select({
            rolePermissionId: rolePermissionAssign.rolePermissionId,
            permissionType: rolePermissionAssign.permissionType,
          })
          .from(rolePermissionAssign)
          .where(
            and(
              eq(rolePermissionAssign.refRoleId, role.roleId),
              eq(
                rolePermissionAssign.refPermissionId,
                ratecardPermission.permissionId,
              ),
            ),
          )
          .limit(1);

        if (!existing) {
          await tx.insert(rolePermissionAssign).values({
            refRoleId: role.roleId,
            refPermissionId: ratecardPermission.permissionId,
            permissionType: grant.permissionType,
          });
        } else if (existing.permissionType !== grant.permissionType) {
          // Reconcile a changed grant level on rerun (ordering-seed
          // precedent); matching grants are left untouched.
          await tx
            .update(rolePermissionAssign)
            .set({
              permissionType: grant.permissionType,
              lastModifiedDatetime: new Date(),
            })
            .where(
              eq(
                rolePermissionAssign.rolePermissionId,
                existing.rolePermissionId,
              ),
            );
        }
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
