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
import { appuser, session } from "@/db/schema/identity";
import { auditLog } from "@/db/schema/audit";
import { roles } from "@/db/schema/roles";
import { permissions } from "@/db/schema/permissions";
import { rolePermissionAssign } from "@/db/schema/role-permission-assign";
import { roleAssign } from "@/db/schema/role-assign";
import type { disableUserAction as DisableUserAction } from "@/actions/users/disable-user.action";
import type { enableUserAction as EnableUserAction } from "@/actions/users/enable-user.action";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// Exercises the real `disableUserAction`/`enableUserAction` (guard +
// validation + service + revalidatePath) against a live Postgres database,
// mirroring tests/actions/assign-revoke-role.action.integration.test.ts.
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
  "disableUserAction / enableUserAction (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let disableUserAction: typeof DisableUserAction;
    let enableUserAction: typeof EnableUserAction;

    let adminUserId: string;
    let noGrantsUserId: string;
    let targetUserId: string;
    let adminRoleId: string;

    function mockSession(userId: string | null): void {
      getSessionMock.mockResolvedValue(
        userId ? { user: { id: userId } } : null,
      );
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      ({ disableUserAction } =
        await import("@/actions/users/disable-user.action"));
      ({ enableUserAction } =
        await import("@/actions/users/enable-user.action"));

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

    describe("disableUserAction", () => {
      it("admin_user disables the user, deletes their session, and writes a USER_DISABLED audit row", async () => {
        mockSession(adminUserId);
        await db.insert(session).values({
          id: randomUUID(),
          userId: targetUserId,
          sessionToken: randomUUID(),
          expiresAt: new Date(Date.now() + 60_000),
        });

        const [before] = await db
          .select({ lastModifiedDatetime: appuser.lastModifiedDatetime })
          .from(appuser)
          .where(eq(appuser.id, targetUserId));

        const result = await disableUserAction({ userId: targetUserId });

        expect(result).toEqual({ ok: true });

        const [userRow] = await db
          .select()
          .from(appuser)
          .where(eq(appuser.id, targetUserId));
        expect(userRow?.status).toBe("DISABLED");
        expect(userRow?.lastModifiedDatetime.getTime()).toBeGreaterThan(
          before!.lastModifiedDatetime.getTime(),
        );

        const sessions = await db
          .select()
          .from(session)
          .where(eq(session.userId, targetUserId));
        expect(sessions).toHaveLength(0);

        const [auditRow] = await db
          .select()
          .from(auditLog)
          .where(eq(auditLog.targetId, targetUserId));
        expect(auditRow?.eventType).toBe("USER_DISABLED");
        expect(auditRow?.actorUserId).toBe(adminUserId);
        expect(auditRow?.targetEntity).toBe("APPUSER");
        expect(auditRow?.beforeData).toEqual({ status: "ACTIVE" });
        expect(auditRow?.afterData).toEqual({ status: "DISABLED" });
      });

      it("disabling a user with no active sessions succeeds without error", async () => {
        mockSession(adminUserId);

        const result = await disableUserAction({ userId: targetUserId });

        expect(result).toEqual({ ok: true });
      });

      it("blocks disabling the only remaining ADMIN, with no DB writes", async () => {
        mockSession(adminUserId);

        const result = await disableUserAction({ userId: adminUserId });

        expect(result).toEqual({ ok: false, code: "LAST_ADMIN" });

        const [userRow] = await db
          .select()
          .from(appuser)
          .where(eq(appuser.id, adminUserId));
        expect(userRow?.status).toBe("ACTIVE");

        const auditRows = await db
          .select()
          .from(auditLog)
          .where(eq(auditLog.targetId, adminUserId));
        expect(auditRows).toHaveLength(0);
      });

      it("returns USER_NOT_FOUND for a non-existent userId", async () => {
        mockSession(adminUserId);

        const result = await disableUserAction({ userId: randomUUID() });

        expect(result).toEqual({ ok: false, code: "USER_NOT_FOUND" });
      });

      it("returns INVALID_STATE for an already-DISABLED user", async () => {
        mockSession(adminUserId);
        await disableUserAction({ userId: targetUserId });

        const result = await disableUserAction({ userId: targetUserId });

        expect(result).toEqual({ ok: false, code: "INVALID_STATE" });
      });

      it("no_grants_user is forbidden, leaving the user unchanged", async () => {
        mockSession(noGrantsUserId);

        const result = await disableUserAction({ userId: targetUserId });

        expect(result).toEqual({ ok: false, code: "FORBIDDEN" });

        const [userRow] = await db
          .select()
          .from(appuser)
          .where(eq(appuser.id, targetUserId));
        expect(userRow?.status).toBe("ACTIVE");
      });

      it("an unauthenticated caller is forbidden", async () => {
        mockSession(null);

        const result = await disableUserAction({ userId: targetUserId });

        expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
      });
    });

    describe("enableUserAction", () => {
      it("admin_user enables a DISABLED user and writes a USER_ENABLED audit row", async () => {
        mockSession(adminUserId);
        await disableUserAction({ userId: targetUserId });

        const result = await enableUserAction({ userId: targetUserId });

        expect(result).toEqual({ ok: true });

        const [userRow] = await db
          .select()
          .from(appuser)
          .where(eq(appuser.id, targetUserId));
        expect(userRow?.status).toBe("ACTIVE");

        const [auditRow] = await db
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.targetId, targetUserId),
              eq(auditLog.eventType, "USER_ENABLED"),
            ),
          );
        expect(auditRow?.actorUserId).toBe(adminUserId);
        expect(auditRow?.targetEntity).toBe("APPUSER");
        expect(auditRow?.targetId).toBe(targetUserId);
        expect(auditRow?.beforeData).toEqual({ status: "DISABLED" });
        expect(auditRow?.afterData).toEqual({ status: "ACTIVE" });
      });

      it("returns USER_NOT_FOUND for a non-existent userId", async () => {
        mockSession(adminUserId);

        const result = await enableUserAction({ userId: randomUUID() });

        expect(result).toEqual({ ok: false, code: "USER_NOT_FOUND" });
      });

      it("returns INVALID_STATE for an ACTIVE user", async () => {
        mockSession(adminUserId);

        const result = await enableUserAction({ userId: targetUserId });

        expect(result).toEqual({ ok: false, code: "INVALID_STATE" });
      });

      it("no_grants_user is forbidden", async () => {
        mockSession(adminUserId);
        await disableUserAction({ userId: targetUserId });
        mockSession(noGrantsUserId);

        const result = await enableUserAction({ userId: targetUserId });

        expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
      });
    });
  },
);
