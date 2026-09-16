import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq } from "drizzle-orm";

import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import * as schema from "@/db/schema";
import { roles } from "@/db/schema/roles";
import { permissions } from "@/db/schema/permissions";
import { rolePermissionAssign } from "@/db/schema/role-permission-assign";
import type { Database } from "@/db/client";

// pm25-spec §3: MANAGER/ADMIN hold EDIT on both ordering permissions, USER
// holds READ. Idempotent per grant.
async function grantOrderingPermissions(tx: Database): Promise<void> {
  const roleRows = await tx
    .select({ roleId: roles.roleId, roleName: roles.roleName })
    .from(roles);
  const roleId = (name: string): string => {
    const row = roleRows.find((r) => r.roleName === name);
    if (!row) {
      throw new Error(`${name} role not found. Run db:seed-rbac first.`);
    }
    return row.roleId;
  };
  const managerRoleId = roleId("MANAGER");
  const userRoleId = roleId("USER");
  const adminRoleId = roleId("ADMIN");

  const grantsByPermission: {
    permissionName: "product_orders" | "product_inventory";
    grants: { roleId: string; permissionType: "READ" | "EDIT" }[];
  }[] = [
    {
      permissionName: "product_orders",
      grants: [
        { roleId: managerRoleId, permissionType: "EDIT" },
        { roleId: userRoleId, permissionType: "READ" },
        { roleId: adminRoleId, permissionType: "EDIT" },
      ],
    },
    {
      permissionName: "product_inventory",
      grants: [
        { roleId: managerRoleId, permissionType: "EDIT" },
        { roleId: userRoleId, permissionType: "READ" },
        { roleId: adminRoleId, permissionType: "EDIT" },
      ],
    },
  ];

  for (const { permissionName, grants } of grantsByPermission) {
    const [permission] = await tx
      .select({ permissionId: permissions.permissionId })
      .from(permissions)
      .where(eq(permissions.permissionName, permissionName))
      .limit(1);
    if (!permission) {
      throw new Error(
        `${permissionName} permission not found. Run db:migrate first.`,
      );
    }
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
            eq(rolePermissionAssign.refPermissionId, permission.permissionId),
          ),
        )
        .limit(1);
      if (!existing) {
        await tx.insert(rolePermissionAssign).values({
          refRoleId: grant.roleId,
          refPermissionId: permission.permissionId,
          permissionType: grant.permissionType,
        });
      } else if (existing.permissionType !== grant.permissionType) {
        // Reconcile a changed grant level on rerun (accounts-seed precedent);
        // matching grants are left untouched, keeping reruns idempotent.
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
  }
}

// Standalone script (`npm run db:seed-ordering`) — never imported by
// application code. Depends on `seed-rbac.ts` (roles). Idempotent: grants are
// checked per-row.
//
// This is the mandatory remainder of the former mixed ordering seed. The demo
// story it used to carry (the `Demo — *` org/orders/inventory fixture) moved to
// the opt-in, prod-guarded `db:seed-demo` (`db/seeds/demo/`), so `db:setup`
// seeds zero demo rows — only these grants.
async function main(): Promise<void> {
  const sql = postgres(config.DATABASE_URL, { max: 1 });
  // Full schema (not a narrow subset) so the transaction handle matches the
  // `Database` type the helper above accepts (seed-accounts precedent).
  const db = drizzle(sql, { schema });

  try {
    await db.transaction(async (tx) => {
      await grantOrderingPermissions(tx);
    });

    logger.info("Ordering & inventory permissions seeded successfully.");
  } finally {
    await sql.end();
  }
}

void main().catch((err: unknown) => {
  logger.error("Ordering & inventory seed failed.", {
    message: err instanceof Error ? err.message : "Unknown error",
  });
  process.exit(1);
});
