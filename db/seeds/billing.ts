import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, inArray, sql } from "drizzle-orm";

import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import * as schema from "@/db/schema";
import { roles } from "@/db/schema/roles";
import { permissions } from "@/db/schema/permissions";
import { rolePermissionAssign } from "@/db/schema/role-permission-assign";
import type { PermissionName, SeededRoleName } from "@/types/rbac";
import type { Database } from "@/db/client";

// bm01-spec §4: the Billing Viewer role (Finance, Internal Audit) carries
// `billrun_view` alone. It is a SEEDED_ROLE_NAMES member, so the Roles UI
// protects it from deletion via `isSeededRole` (types/rbac.ts).
const BILLING_VIEWER: SeededRoleName = "BILLING_VIEWER";

// bm01-spec §4: grants target the levels the guards check — view=READ,
// operate=EDIT, approve=EDIT (there is no DELETE level in billing v1).
const BILLING_VIEWER_GRANTS: {
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
// code. Depends on `seed-rbac.ts` (the ADMIN role) and the 0024 migration (the
// three billrun_* permission rows). Idempotent: the BILLING_VIEWER role is
// created only if absent, and grants are reconciled with an atomic upsert
// (insert-or-update-when-different), so a re-run converges to the declared
// grants without spurious writes and is safe under concurrent execution.
async function main(): Promise<void> {
  const sql = postgres(config.DATABASE_URL, { max: 1 });
  // Full schema (not a narrow subset) so the transaction handle matches the
  // `Database` type the helpers above accept (seed-ordering precedent).
  const db = drizzle(sql, { schema });

  try {
    await db.transaction(async (tx) => {
      const permissionIdByName = await resolvePermissionIds(tx);

      // 1) BILLING_VIEWER role — create once (idempotency pre-check).
      let [billingViewerRole] = await tx
        .select({ roleId: roles.roleId })
        .from(roles)
        .where(eq(roles.roleName, BILLING_VIEWER))
        .limit(1);
      if (!billingViewerRole) {
        [billingViewerRole] = await tx
          .insert(roles)
          .values({
            roleName: BILLING_VIEWER,
            roleDescr:
              "Read-only access to Bill Runs (list, drill-down, export) for Finance and Internal Audit.",
          })
          .returning({ roleId: roles.roleId });
      }

      // 2) BILLING_VIEWER → billrun_view : READ.
      await grant(
        tx,
        billingViewerRole!.roleId,
        permissionIdByName,
        BILLING_VIEWER_GRANTS,
      );

      // 3) ADMIN → billrun_view:READ, billrun_operate:EDIT, billrun_approve:EDIT
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

    logger.info(
      "Billing RBAC (Billing Viewer role + grants) seeded successfully.",
    );
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
