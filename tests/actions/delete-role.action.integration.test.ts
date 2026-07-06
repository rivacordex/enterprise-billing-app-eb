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
import type { deleteRoleAction as DeleteRoleAction } from "@/actions/roles/delete-role.action";

// Exercises the real `deleteRoleAction` (guard + validation + service +
// revalidatePath) against a live Postgres database, mirroring
// tests/actions/update-role.action.integration.test.ts.
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
  "deleteRoleAction (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let deleteRoleAction: typeof DeleteRoleAction;

    let adminUserId: string;
    let noGrantsUserId: string;
    let adminRoleId: string;
    let managerRoleId: string;
    let userRoleId: string;
    let testRoleId: string;
    let testRoleName: string;
    let rolesPermissionId: string;
    let usersPermissionId: string;

    function mockSession(userId: string | null): void {
      getSessionMock.mockResolvedValue(
        userId ? { user: { id: userId } } : null,
      );
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      ({ deleteRoleAction } =
        await import("@/actions/roles/delete-role.action"));

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

      const insertedRoles = await db
        .insert(roles)
        .values([
          { roleName: "ADMIN", roleDescr: "Admin" },
          { roleName: "MANAGER", roleDescr: null },
          { roleName: "USER", roleDescr: null },
        ])
        .returning({ roleId: roles.roleId, roleName: roles.roleName });
      adminRoleId = insertedRoles.find((r) => r.roleName === "ADMIN")!.roleId;
      managerRoleId = insertedRoles.find(
        (r) => r.roleName === "MANAGER",
      )!.roleId;
      userRoleId = insertedRoles.find((r) => r.roleName === "USER")!.roleId;

      const insertedPermissions = await db
        .insert(permissions)
        .values([
          { permissionName: "roles", permissionInfo: "Roles" },
          { permissionName: "users", permissionInfo: "Users" },
        ])
        .returning({
          permissionId: permissions.permissionId,
          permissionName: permissions.permissionName,
        });
      rolesPermissionId = insertedPermissions.find(
        (p) => p.permissionName === "roles",
      )!.permissionId;
      usersPermissionId = insertedPermissions.find(
        (p) => p.permissionName === "users",
      )!.permissionId;

      await db.insert(rolePermissionAssign).values({
        refRoleId: adminRoleId,
        refPermissionId: rolesPermissionId,
        permissionType: "DELETE",
      });

      await db.insert(roleAssign).values({
        refUserId: adminUserId,
        refRoleId: adminRoleId,
        assignedBy: null,
      });
    }, 30_000);

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    beforeEach(async () => {
      getSessionMock.mockReset();
      // Each test gets its own fixture row — `roles.role_name` is unique,
      // and these tests run sequentially against the same database without
      // per-test cleanup.
      testRoleName = `TestRole-${randomUUID()}`;
      const [testRole] = await db
        .insert(roles)
        .values({ roleName: testRoleName, roleDescr: "To be deleted" })
        .returning({ roleId: roles.roleId });
      testRoleId = testRole!.roleId;
    });

    it("admin_user deletes a non-seeded, unassigned role and writes a ROLE_DELETED audit row", async () => {
      mockSession(adminUserId);
      await db.insert(rolePermissionAssign).values({
        refRoleId: testRoleId,
        refPermissionId: usersPermissionId,
        permissionType: "READ",
      });

      const result = await deleteRoleAction({ roleId: testRoleId });

      expect(result).toEqual({ ok: true });

      const [roleRow] = await db
        .select()
        .from(roles)
        .where(eq(roles.roleId, testRoleId));
      expect(roleRow).toBeUndefined();

      const mappingRows = await db
        .select()
        .from(rolePermissionAssign)
        .where(eq(rolePermissionAssign.refRoleId, testRoleId));
      expect(mappingRows).toHaveLength(0);

      const [auditRow] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, testRoleId));
      expect(auditRow?.eventType).toBe("ROLE_DELETED");
      expect(auditRow?.actorUserId).toBe(adminUserId);
      expect(auditRow?.beforeData).toEqual({
        roleName: testRoleName,
        roleDescr: "To be deleted",
        permissionMappings: [
          { permissionName: "users", permissionType: "READ" },
        ],
      });
      expect(auditRow?.afterData).toBeNull();
    });

    it("returns SEEDED_ROLE for ADMIN and does not delete the row", async () => {
      mockSession(adminUserId);

      const result = await deleteRoleAction({ roleId: adminRoleId });

      expect(result).toEqual({ ok: false, code: "SEEDED_ROLE" });
      const [roleRow] = await db
        .select()
        .from(roles)
        .where(eq(roles.roleId, adminRoleId));
      expect(roleRow).toBeDefined();
    });

    it("returns SEEDED_ROLE for MANAGER", async () => {
      mockSession(adminUserId);

      const result = await deleteRoleAction({ roleId: managerRoleId });

      expect(result).toEqual({ ok: false, code: "SEEDED_ROLE" });
    });

    it("returns SEEDED_ROLE for USER", async () => {
      mockSession(adminUserId);

      const result = await deleteRoleAction({ roleId: userRoleId });

      expect(result).toEqual({ ok: false, code: "SEEDED_ROLE" });
    });

    it("returns ROLE_NOT_FOUND for a non-existent roleId", async () => {
      mockSession(adminUserId);

      const result = await deleteRoleAction({ roleId: randomUUID() });

      expect(result).toEqual({ ok: false, code: "ROLE_NOT_FOUND" });
    });

    it("returns ROLE_IN_USE with the assigned count and does not delete the row", async () => {
      mockSession(adminUserId);
      await db.insert(roleAssign).values({
        refUserId: adminUserId,
        refRoleId: testRoleId,
        assignedBy: adminUserId,
      });

      const result = await deleteRoleAction({ roleId: testRoleId });

      expect(result).toEqual({
        ok: false,
        code: "ROLE_IN_USE",
        assignedCount: 1,
      });

      const [roleRow] = await db
        .select()
        .from(roles)
        .where(eq(roles.roleId, testRoleId));
      expect(roleRow).toBeDefined();

      await db.delete(roleAssign).where(eq(roleAssign.refRoleId, testRoleId));
    });

    it("no_grants_user is forbidden and the role is not deleted", async () => {
      mockSession(noGrantsUserId);

      const result = await deleteRoleAction({ roleId: testRoleId });

      expect(result).toEqual({ ok: false, code: "FORBIDDEN" });

      const [roleRow] = await db
        .select()
        .from(roles)
        .where(eq(roles.roleId, testRoleId));
      expect(roleRow).toBeDefined();
    });

    it("redirects to /login when there is no session (FORBIDDEN at the action boundary)", async () => {
      mockSession(null);

      const result = await deleteRoleAction({ roleId: testRoleId });

      expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    });
  },
);
