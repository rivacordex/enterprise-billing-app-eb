import { randomUUID } from "node:crypto";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import { auditLog } from "@/db/schema/audit";
import { roles } from "@/db/schema/roles";
import { permissions } from "@/db/schema/permissions";
import { rolePermissionAssign } from "@/db/schema/role-permission-assign";
import { roleAssign } from "@/db/schema/role-assign";
import type { assignRoleAction as AssignRoleAction } from "@/actions/users/assign-role.action";
import type { revokeRoleAction as RevokeRoleAction } from "@/actions/users/revoke-role.action";

// Exercises the real `assignRoleAction`/`revokeRoleAction` (guard +
// validation + service + revalidatePath) against a live Postgres database,
// mirroring tests/actions/update-user-details.action.integration.test.ts.
const databaseUrl = process.env.DATABASE_URL;

const getSessionMock = vi.fn();
vi.mock("@/auth", () => ({
  auth: { api: { getSession: getSessionMock } },
}));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

describe.skipIf(!databaseUrl)(
  "assignRoleAction / revokeRoleAction (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let assignRoleAction: typeof AssignRoleAction;
    let revokeRoleAction: typeof RevokeRoleAction;

    let adminUserId: string;
    let noGrantsUserId: string;
    let targetUserId: string;
    let adminRoleId: string;
    let testRoleId: string;

    function mockSession(userId: string | null): void {
      getSessionMock.mockResolvedValue(
        userId ? { user: { id: userId } } : null,
      );
    }

    beforeAll(async () => {
      sql = postgres(databaseUrl as string, { max: 1 });
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      ({ assignRoleAction } =
        await import("@/actions/users/assign-role.action"));
      ({ revokeRoleAction } =
        await import("@/actions/users/revoke-role.action"));

      adminUserId = randomUUID();
      noGrantsUserId = randomUUID();

      await db.insert(appuser).values([
        {
          id: adminUserId,
          userName: "Admin User",
          userEmail: `${adminUserId}@example.com`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        },
        {
          id: noGrantsUserId,
          userName: "No Grants User",
          userEmail: `${noGrantsUserId}@example.com`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        },
      ]);

      const [adminRole] = await db
        .insert(roles)
        .values({ roleName: "ADMIN", roleDescr: "Admin" })
        .returning({ roleId: roles.roleId });
      adminRoleId = adminRole!.roleId;

      const [testRole] = await db
        .insert(roles)
        .values({ roleName: "TEST_ROLE", roleDescr: "Test role" })
        .returning({ roleId: roles.roleId });
      testRoleId = testRole!.roleId;

      const [usersPermission] = await db
        .insert(permissions)
        .values({ permissionName: "users", permissionInfo: "Users" })
        .returning({ permissionId: permissions.permissionId });

      await db.insert(rolePermissionAssign).values({
        refRoleId: adminRoleId,
        refPermissionId: usersPermission!.permissionId,
        permissionType: "EDIT",
      });

      await db.insert(roleAssign).values({
        refUserId: adminUserId,
        refRoleId: adminRoleId,
        assignedBy: null,
      });
    }, 30_000);

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    beforeEach(async () => {
      getSessionMock.mockReset();
      targetUserId = randomUUID();
      await db.insert(appuser).values({
        id: targetUserId,
        userName: "Target User",
        userEmail: `${targetUserId}@example.com`,
        emailVerified: false,
        authMethod: "LOCAL",
        status: "ACTIVE",
      });
    });

    it("admin_user assigns a role, writing a role_assign row and a ROLE_ASSIGNED audit row", async () => {
      mockSession(adminUserId);

      const result = await assignRoleAction({
        userId: targetUserId,
        roleId: testRoleId,
      });

      expect(result).toEqual({ ok: true });

      const [assignRow] = await db
        .select()
        .from(roleAssign)
        .where(
          and(
            eq(roleAssign.refUserId, targetUserId),
            eq(roleAssign.refRoleId, testRoleId),
          ),
        );
      expect(assignRow?.assignedBy).toBe(adminUserId);

      const [auditRow] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, assignRow!.roleAssignId));
      expect(auditRow?.eventType).toBe("ROLE_ASSIGNED");
      expect(auditRow?.actorUserId).toBe(adminUserId);
      expect(auditRow?.targetEntity).toBe("ROLE_ASSIGN");
      expect(auditRow?.beforeData).toBeNull();
      expect(
        (auditRow?.afterData as { roleName?: string } | null)?.roleName,
      ).toBe("TEST_ROLE");
    });

    it("admin_user revokes a previously assigned role, deleting the row and writing a ROLE_REVOKED audit row", async () => {
      mockSession(adminUserId);
      await assignRoleAction({ userId: targetUserId, roleId: testRoleId });
      const [assignedRow] = await db
        .select()
        .from(roleAssign)
        .where(
          and(
            eq(roleAssign.refUserId, targetUserId),
            eq(roleAssign.refRoleId, testRoleId),
          ),
        );

      const result = await revokeRoleAction({
        userId: targetUserId,
        roleId: testRoleId,
      });

      expect(result).toEqual({ ok: true });

      const remaining = await db
        .select()
        .from(roleAssign)
        .where(eq(roleAssign.refUserId, targetUserId));
      expect(remaining).toHaveLength(0);

      // Scoped to this specific assignment's id *and* the REVOKED event —
      // the ROLE_ASSIGNED row written moments earlier shares the same
      // targetId (the same role_assign row's id), and other tests in this
      // suite write ROLE_REVOKED rows for other users/roles.
      const auditRows = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.targetId, assignedRow!.roleAssignId),
            eq(auditLog.eventType, "ROLE_REVOKED"),
          ),
        );
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]?.eventType).toBe("ROLE_REVOKED");
      expect(auditRows[0]?.actorUserId).toBe(adminUserId);
    });

    it("assigning the same role twice returns ALREADY_ASSIGNED on the second call", async () => {
      mockSession(adminUserId);
      await assignRoleAction({ userId: targetUserId, roleId: testRoleId });

      const result = await assignRoleAction({
        userId: targetUserId,
        roleId: testRoleId,
      });

      expect(result).toEqual({ ok: false, code: "ALREADY_ASSIGNED" });

      const rows = await db
        .select()
        .from(roleAssign)
        .where(eq(roleAssign.refUserId, targetUserId));
      expect(rows).toHaveLength(1);
    });

    it("blocks revoking ADMIN from the only non-DELETED user holding it", async () => {
      mockSession(adminUserId);

      const result = await revokeRoleAction({
        userId: adminUserId,
        roleId: adminRoleId,
      });

      expect(result).toEqual({ ok: false, code: "LAST_ADMIN_ROLE" });

      const rows = await db
        .select()
        .from(roleAssign)
        .where(eq(roleAssign.refUserId, adminUserId));
      expect(rows).toHaveLength(1);
    });

    it("no_grants_user is forbidden to assign", async () => {
      mockSession(noGrantsUserId);

      const result = await assignRoleAction({
        userId: targetUserId,
        roleId: testRoleId,
      });

      expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    });

    it("no_grants_user is forbidden to revoke", async () => {
      mockSession(adminUserId);
      await assignRoleAction({ userId: targetUserId, roleId: testRoleId });
      mockSession(noGrantsUserId);

      const result = await revokeRoleAction({
        userId: targetUserId,
        roleId: testRoleId,
      });

      expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    });
  },
);
