import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, inArray, sql } from "drizzle-orm";

import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import * as schema from "@/db/schema";
import { roles } from "@/db/schema/roles";
import { permissions } from "@/db/schema/permissions";
import { rolePermissionAssign } from "@/db/schema/role-permission-assign";
import type { PermissionName } from "@/types/rbac";
import type { Database } from "@/db/client";

// bm01-spec §4 (amended by the seed-refactor change, 2026-09-16): bill-run read
// access is ordinary Revenue Ops work, carried by the platform's standard
// business roles — there is no dedicated viewer role. `billrun_view:READ` is
// granted to MANAGER and USER; the former dedicated viewer role (framed for
// Finance/Internal Audit) is retired. `billrun_operate`/`billrun_approve` stay
// ADMIN-only. Grants target the levels the guards check — view=READ (there is no
// DELETE level in billing v1).
const REVENUE_OPS_ROLES = ["MANAGER", "USER"] as const;

const REVENUE_OPS_GRANTS: {
  permissionName: PermissionName;
  permissionType: "READ" | "EDIT";
}[] = [{ permissionName: "billrun_view", permissionType: "READ" }];

const ADMIN_GRANTS: {
  permissionName: PermissionName;
  permissionType: "READ" | "EDIT";
}[] = [
  { permissionName: "billrun_view", permissionType: "READ" },
  { permissionName: "billrun_operate", permissionType: "EDIT" },
  { permissionName: "billrun_approve", permissionType: "EDIT" },
];

async function resolvePermissionIds(
  tx: Database,
): Promise<Map<PermissionName, string>> {
  const names: PermissionName[] = [
    "billrun_view",
    "billrun_operate",
    "billrun_approve",
  ];
  const rows = await tx
    .select({
      permissionId: permissions.permissionId,
      permissionName: permissions.permissionName,
    })
    .from(permissions)
    .where(inArray(permissions.permissionName, names));
  const byName = new Map(
    rows.map((r) => [r.permissionName as PermissionName, r.permissionId]),
  );
  for (const name of names) {
    if (!byName.has(name)) {
      throw new Error(
        `Permission '${name}' not found. Run db:migrate first (0024_billrun_permissions).`,
      );
    }
  }
  return byName;
}

async function grant(
  tx: Database,
  roleId: string,
  permissionIdByName: Map<PermissionName, string>,
  grants: { permissionName: PermissionName; permissionType: "READ" | "EDIT" }[],
): Promise<void> {
  // Reconcile the declared grants in one atomic upsert (race-safe, unlike a
  // check-then-act select+insert): insert when absent, and on the
  // (ref_role_id, ref_permission_id) unique conflict update the level only when
  // it actually differs. So the seed is the source of truth for its grants, a
  // concurrent re-run can't hit a unique violation, and a no-change re-run
  // writes nothing (the `setWhere` guard). A role carries at most one level per
  // permission.
  await tx
    .insert(rolePermissionAssign)
    .values(
      grants.map((g) => ({
        refRoleId: roleId,
        refPermissionId: permissionIdByName.get(g.permissionName)!,
        permissionType: g.permissionType,
      })),
    )
    .onConflictDoUpdate({
      target: [
        rolePermissionAssign.refRoleId,
        rolePermissionAssign.refPermissionId,
      ],
      set: {
        permissionType: sql`excluded.permission_type`,
        lastModifiedDatetime: sql`now()`,
      },
      setWhere: sql`${rolePermissionAssign.permissionType} is distinct from excluded.permission_type`,
    });
}

// Standalone script (`npm run db:seed-billing`) — never imported by application
// code. Depends on `seed-rbac.ts` (the ADMIN/MANAGER/USER roles) and the 0024
// migration (the three billrun_* permission rows). Idempotent: grants are
// reconciled with an atomic upsert (insert-or-update-when-different), so a
// re-run converges to the declared grants without spurious writes and is safe
// under concurrent execution.
async function main(): Promise<void> {
  const sql = postgres(config.DATABASE_URL, { max: 1 });
  // Full schema (not a narrow subset) so the transaction handle matches the
  // `Database` type the helpers above accept (seed-ordering precedent).
  const db = drizzle(sql, { schema });

  try {
    await db.transaction(async (tx) => {
      const permissionIdByName = await resolvePermissionIds(tx);

      // 1) Revenue Ops rollup — MANAGER and USER each carry billrun_view:READ.
      for (const roleName of REVENUE_OPS_ROLES) {
        const [role] = await tx
          .select({ roleId: roles.roleId })
          .from(roles)
          .where(eq(roles.roleName, roleName))
          .limit(1);
        if (!role) {
          throw new Error(
            `${roleName} role not found. Run db:seed-rbac first.`,
          );
        }
        await grant(tx, role.roleId, permissionIdByName, REVENUE_OPS_GRANTS);
      }

      // 2) ADMIN → billrun_view:READ, billrun_operate:EDIT, billrun_approve:EDIT
      //    so the platform admin can operate the module out of the box.
      const [adminRole] = await tx
        .select({ roleId: roles.roleId })
        .from(roles)
        .where(eq(roles.roleName, "ADMIN"))
        .limit(1);
      if (!adminRole) {
        throw new Error("ADMIN role not found. Run db:seed-rbac first.");
      }
      await grant(tx, adminRole.roleId, permissionIdByName, ADMIN_GRANTS);
    });

    logger.info("Billing RBAC (billrun grants) seeded successfully.");
  } finally {
    await sql.end();
  }
}

void main().catch((err: unknown) => {
  logger.error("Billing seed failed.", {
    message: err instanceof Error ? err.message : "Unknown error",
  });
  process.exit(1);
});
