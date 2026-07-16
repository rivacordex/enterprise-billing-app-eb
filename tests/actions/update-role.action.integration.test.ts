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
import { eq } from "drizzle-orm";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import { auditLog } from "@/db/schema/audit";
import { roles } from "@/db/schema/roles";
import { permissions } from "@/db/schema/permissions";
import { rolePermissionAssign } from "@/db/schema/role-permission-assign";
import { roleAssign } from "@/db/schema/role-assign";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import type { updateRoleAction as UpdateRoleAction } from "@/actions/roles/update-role.action";

// Exercises the real `updateRoleAction` (guard + validation + service +
// revalidatePath) against a live Postgres database, mirroring
// tests/actions/update-user-details.action.integration.test.ts.
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
  "updateRoleAction (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let updateRoleAction: typeof UpdateRoleAction;

    let adminUserId: string;
    let noGrantsUserId: string;
    let testRoleId: string;
    let testRoleName: string;

    function mockSession(userId: string | null): void {
      getSessionMock.mockResolvedValue(
        userId ? { user: { id: userId } } : null,
      );
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
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

      ({ updateRoleAction } =
        await import("@/actions/roles/update-role.action"));

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

      const [rolesPermission] = await db
        .insert(permissions)
        .values({ permissionName: "roles", permissionInfo: "Roles" })
        .returning({ permissionId: permissions.permissionId });

      await db.insert(rolePermissionAssign).values({
        refRoleId: adminRole!.roleId,
        refPermissionId: rolesPermission!.permissionId,
        permissionType: "EDIT",
      });

      await db.insert(roleAssign).values({
        refUserId: adminUserId,
        refRoleId: adminRole!.roleId,
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
      // Each test gets its own fixture row — `roles.role_name` is unique,
      // and these tests run sequentially against the same database without
      // per-test cleanup, so a fixed literal name would collide once an
      // earlier test renamed (or left unrenamed) its own row.
      testRoleName = `TestRole-${randomUUID()}`;
      const [testRole] = await db
        .insert(roles)
        .values({ roleName: testRoleName, roleDescr: null })
        .returning({ roleId: roles.roleId });
      testRoleId = testRole!.roleId;
    });

    it("admin_user renames the role, updates descr, and writes a ROLE_UPDATED audit row", async () => {
      mockSession(adminUserId);

      const [before] = await db
        .select({ lastModifiedDatetime: roles.lastModifiedDatetime })
        .from(roles)
        .where(eq(roles.roleId, testRoleId));

      const result = await updateRoleAction({
        roleId: testRoleId,
        roleName: "TestRoleRenamed",
        roleDescr: "New desc",
      });

      expect(result).toEqual({ ok: true });

      const [roleRow] = await db
        .select()
        .from(roles)
        .where(eq(roles.roleId, testRoleId));
      expect(roleRow?.roleName).toBe("TestRoleRenamed");
      expect(roleRow?.roleDescr).toBe("New desc");
      expect(roleRow?.lastModifiedDatetime.getTime()).toBeGreaterThan(
        before!.lastModifiedDatetime.getTime(),
      );

      const [auditRow] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, testRoleId));
      expect(auditRow?.eventType).toBe("ROLE_UPDATED");
      expect(auditRow?.actorUserId).toBe(adminUserId);
      expect(auditRow?.beforeData).toEqual({
        roleName: testRoleName,
        roleDescr: null,
      });
      expect(auditRow?.afterData).toEqual({
        roleName: "TestRoleRenamed",
        roleDescr: "New desc",
      });
    });

    it("rejects renaming to an existing (case-insensitive) role name", async () => {
      mockSession(adminUserId);

      const result = await updateRoleAction({
        roleId: testRoleId,
        roleName: "ADMIN",
      });

      expect(result).toEqual({ ok: false, code: "NAME_CONFLICT" });
    });

    it("short-circuits with no DB write or audit row when name/descr are unchanged", async () => {
      mockSession(adminUserId);

      const [before] = await db
        .select({ lastModifiedDatetime: roles.lastModifiedDatetime })
        .from(roles)
        .where(eq(roles.roleId, testRoleId));

      const result = await updateRoleAction({
        roleId: testRoleId,
        roleName: testRoleName,
        roleDescr: null,
      });

      expect(result).toEqual({ ok: true });

      const [roleRow] = await db
        .select()
        .from(roles)
        .where(eq(roles.roleId, testRoleId));
      expect(roleRow?.lastModifiedDatetime.getTime()).toBe(
        before!.lastModifiedDatetime.getTime(),
      );

      const auditRows = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, testRoleId));
      expect(auditRows).toHaveLength(0);
    });

    it("returns ROLE_NOT_FOUND for a non-existent roleId", async () => {
      mockSession(adminUserId);
      const missingRoleId = randomUUID();

      const result = await updateRoleAction({
        roleId: missingRoleId,
        roleName: "Whatever",
      });

      expect(result).toEqual({ ok: false, code: "ROLE_NOT_FOUND" });
    });

    it("no_grants_user is forbidden", async () => {
      mockSession(noGrantsUserId);

      const result = await updateRoleAction({
        roleId: testRoleId,
        roleName: "Should Not Update",
      });

      expect(result).toEqual({ ok: false, code: "FORBIDDEN" });

      const [roleRow] = await db
        .select()
        .from(roles)
        .where(eq(roles.roleId, testRoleId));
      expect(roleRow?.roleName).toBe(testRoleName);
    });
  },
);
