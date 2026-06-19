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
import type { updateUserDetailsAction as UpdateUserDetailsAction } from "@/actions/users/update-user-details.action";

// Exercises the real `updateUserDetailsAction` (guard + validation +
// service + revalidatePath) against a live Postgres database, mirroring
// tests/actions/create-user.action.integration.test.ts.
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
  "updateUserDetailsAction (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let updateUserDetailsAction: typeof UpdateUserDetailsAction;

    let adminUserId: string;
    let noGrantsUserId: string;
    let targetUserId: string;

    function mockSession(userId: string | null): void {
      getSessionMock.mockResolvedValue(
        userId ? { user: { id: userId } } : null,
      );
    }

    beforeAll(async () => {
      sql = postgres(databaseUrl as string, { max: 1 });
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      ({ updateUserDetailsAction } =
        await import("@/actions/users/update-user-details.action"));

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

      const [usersPermission] = await db
        .insert(permissions)
        .values({ permissionName: "users", permissionInfo: "Users" })
        .returning({ permissionId: permissions.permissionId });

      await db.insert(rolePermissionAssign).values({
        refRoleId: adminRole!.roleId,
        refPermissionId: usersPermission!.permissionId,
        permissionType: "EDIT",
      });

      await db.insert(roleAssign).values({
        refUserId: adminUserId,
        refRoleId: adminRole!.roleId,
        assignedBy: null,
      });
    }, 30_000);

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    beforeEach(async () => {
      getSessionMock.mockReset();
      targetUserId = randomUUID();
      await db.insert(appuser).values({
        id: targetUserId,
        userName: "Original Name",
        userEmail: `${targetUserId}@example.com`,
        userPhonenum: null,
        emailVerified: false,
        authMethod: "LOCAL",
        status: "ACTIVE",
      });
    });

    it("admin_user updates the user, writes a USER_UPDATED audit row, and bumps last_modified_datetime", async () => {
      mockSession(adminUserId);

      const [before] = await db
        .select({ lastModifiedDatetime: appuser.lastModifiedDatetime })
        .from(appuser)
        .where(eq(appuser.id, targetUserId));

      const result = await updateUserDetailsAction({
        userId: targetUserId,
        userName: "Updated",
        userPhonenum: "+1 555 9999",
      });

      expect(result).toEqual({ ok: true });

      const [userRow] = await db
        .select()
        .from(appuser)
        .where(eq(appuser.id, targetUserId));
      expect(userRow?.userName).toBe("Updated");
      expect(userRow?.userPhonenum).toBe("+1 555 9999");
      expect(userRow?.lastModifiedDatetime.getTime()).toBeGreaterThan(
        before!.lastModifiedDatetime.getTime(),
      );

      const [auditRow] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, targetUserId));
      expect(auditRow?.eventType).toBe("USER_UPDATED");
      expect(auditRow?.actorUserId).toBe(adminUserId);
      expect(auditRow?.targetEntity).toBe("APPUSER");
      expect(auditRow?.beforeData).toEqual({
        userName: "Original Name",
        userPhonenum: null,
      });
      expect(auditRow?.afterData).toEqual({
        userName: "Updated",
        userPhonenum: "+1 555 9999",
      });
    });

    it("returns USER_NOT_FOUND for a non-existent userId, with no audit row written", async () => {
      mockSession(adminUserId);
      const missingUserId = randomUUID();

      const result = await updateUserDetailsAction({
        userId: missingUserId,
        userName: "Whoever",
        userPhonenum: null,
      });

      expect(result).toEqual({ ok: false, code: "USER_NOT_FOUND" });

      const auditRows = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, missingUserId));
      expect(auditRows).toHaveLength(0);
    });

    it("no_grants_user is forbidden", async () => {
      mockSession(noGrantsUserId);

      const result = await updateUserDetailsAction({
        userId: targetUserId,
        userName: "Should Not Update",
        userPhonenum: null,
      });

      expect(result).toEqual({ ok: false, code: "FORBIDDEN" });

      const [userRow] = await db
        .select()
        .from(appuser)
        .where(eq(appuser.id, targetUserId));
      expect(userRow?.userName).toBe("Original Name");
    });

    it("an unauthenticated caller is forbidden", async () => {
      mockSession(null);

      const result = await updateUserDetailsAction({
        userId: targetUserId,
        userName: "Should Not Update",
        userPhonenum: null,
      });

      expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    });
  },
);
