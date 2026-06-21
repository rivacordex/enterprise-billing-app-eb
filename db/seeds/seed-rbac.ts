import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";

import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import { appuser } from "@/db/schema/identity";
import { roles } from "@/db/schema/roles";
import { permissions } from "@/db/schema/permissions";
import { rolePermissionAssign } from "@/db/schema/role-permission-assign";
import { roleAssign } from "@/db/schema/role-assign";
import { loadBootstrapAdminConfig } from "@/db/seeds/seed-admin.config";
import type { PermissionName, SeededRoleName } from "@/types/rbac";

const ROLE_SEEDS: { roleName: SeededRoleName; roleDescr: string }[] = [
  {
    roleName: "ADMIN",
    roleDescr:
      "Full access to all administration pages and user lifecycle management.",
  },
  {
    roleName: "MANAGER",
    roleDescr:
      "Rights to perform administrative functions on business related pages",
  },
  {
    roleName: "USER",
    roleDescr:
      "Rights to perform operational or support functions on business related pages",
  },
];

const PERMISSION_SEEDS: {
  permissionName: PermissionName;
  permissionInfo: string;
}[] = [
  {
    permissionName: "users",
    permissionInfo: "Controls access to the Users administration page.",
  },
  {
    permissionName: "roles",
    permissionInfo: "Controls access to the Roles administration page.",
  },
  {
    permissionName: "system_config",
    permissionInfo: "Controls access to the System Configuration page.",
  },
  {
    permissionName: "audit_log",
    permissionInfo: "Controls access to the Audit Log viewer.",
  },
];

const ADMIN_PERMISSION_GRANTS: {
  permissionName: PermissionName;
  permissionType: "READ" | "EDIT" | "DELETE";
}[] = [
  { permissionName: "users", permissionType: "DELETE" },
  { permissionName: "roles", permissionType: "DELETE" },
  { permissionName: "system_config", permissionType: "DELETE" },
  { permissionName: "audit_log", permissionType: "READ" },
];

// Standalone script (`npm run db:seed-rbac`) — never imported by application
// code. Depends on `seed-admin.ts` having already run: the bootstrap admin's
// `user_id` is looked up by email to create the ROLE_ASSIGN row (um05-spec
// §5.8). Idempotent: checks for the ADMIN role row before inserting; all
// four categories are seeded atomically in one transaction, so a single
// pre-check is sufficient.
async function main(): Promise<void> {
  const bootstrapAdmin = loadBootstrapAdminConfig();
  const sql = postgres(config.DATABASE_URL, { max: 1 });
  const db = drizzle(sql, {
    schema: { appuser, roles, permissions, rolePermissionAssign, roleAssign },
  });

  try {
    const [existingAdminRole] = await db
      .select()
      .from(roles)
      .where(eq(roles.roleName, "ADMIN"))
      .limit(1);

    if (existingAdminRole) {
      logger.info("RBAC registry already seeded, skipping.");
      return;
    }

    await db.transaction(async (tx) => {
      const insertedRoles = await tx
        .insert(roles)
        .values(ROLE_SEEDS)
        .returning({ roleId: roles.roleId, roleName: roles.roleName });
      const roleIdByName = new Map(
        insertedRoles.map((r) => [r.roleName, r.roleId]),
      );

      const insertedPermissions = await tx
        .insert(permissions)
        .values(PERMISSION_SEEDS)
        .returning({
          permissionId: permissions.permissionId,
          permissionName: permissions.permissionName,
        });
      const permissionIdByName = new Map(
        insertedPermissions.map((p) => [p.permissionName, p.permissionId]),
      );

      const adminRoleId = roleIdByName.get("ADMIN");
      if (!adminRoleId) {
        throw new Error("ADMIN role was not inserted as expected.");
      }

      await tx.insert(rolePermissionAssign).values(
        ADMIN_PERMISSION_GRANTS.map((grant) => {
          const permissionId = permissionIdByName.get(grant.permissionName);
          if (!permissionId) {
            throw new Error(
              `Permission '${grant.permissionName}' was not inserted as expected.`,
            );
          }
          return {
            refRoleId: adminRoleId,
            refPermissionId: permissionId,
            permissionType: grant.permissionType,
          };
        }),
      );

      const [bootstrapAdminUser] = await tx
        .select({ id: appuser.id })
        .from(appuser)
        .where(eq(appuser.userEmail, bootstrapAdmin.BOOTSTRAP_ADMIN_EMAIL))
        .limit(1);

      if (!bootstrapAdminUser) {
        throw new Error("Bootstrap admin not found. Run db:seed first.");
      }

      // `assigned_by` is NULL here because this is a system bootstrap
      // operation performed at deployment, not an admin UI action. Normal
      // UI-driven role assignments (um13) always supply a non-null
      // `assigned_by`. No AUDIT_LOG row is written for this bootstrap grant
      // either — role assignments made at deployment are infrastructure
      // operations, not operational events (um05-spec §5.8).
      await tx.insert(roleAssign).values({
        refUserId: bootstrapAdminUser.id,
        refRoleId: adminRoleId,
        assignedBy: null,
      });
    });

    logger.info("RBAC registry seeded successfully.");
  } finally {
    await sql.end();
  }
}

void main().catch((err: unknown) => {
  logger.error("RBAC seed failed.", {
    message: err instanceof Error ? err.message : "Unknown error",
  });
  process.exit(1);
});
