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
import type { unlockAccountAction as UnlockAccountAction } from "@/actions/users/unlock-account.action";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// Exercises the real `unlockAccountAction` (guard + validation + service)
// against a live Postgres database, mirroring
// tests/actions/reset-password.action.integration.test.ts.
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
  "unlockAccountAction (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let unlockAccountAction: typeof UnlockAccountAction;

    let adminUserId: string;
    let noGrantsUserId: string;
    let lockedActiveUserId: string;
    let lockedPendingUserId: string;
    let lockedDisabledUserId: string;
    let unlockedUserId: string;
    let deletedUserId: string;

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

      ({ unlockAccountAction } =
        await import("@/actions/users/unlock-account.action"));

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
      const adminRoleId = adminRole!.roleId;

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

      lockedActiveUserId = randomUUID();
      lockedPendingUserId = randomUUID();
      lockedDisabledUserId = randomUUID();
      unlockedUserId = randomUUID();
      deletedUserId = randomUUID();

      const lockedUntil = new Date(Date.now() + 15 * 60 * 1000);

      await db.insert(appuser).values([
        {
          id: lockedActiveUserId,
          userName: "Locked Active User",
          userEmail: `${lockedActiveUserId}@example.com`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
          failedLoginCount: 5,
          lockedUntil,
        },
        {
          id: lockedPendingUserId,
          userName: "Locked Pending User",
          userEmail: `${lockedPendingUserId}@example.com`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "PENDING",
          failedLoginCount: 5,
          lockedUntil,
        },
        {
          id: lockedDisabledUserId,
          userName: "Locked Disabled User",
          userEmail: `${lockedDisabledUserId}@example.com`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "DISABLED",
          failedLoginCount: 5,
          lockedUntil,
        },
        {
          id: unlockedUserId,
          userName: "Unlocked User",
          userEmail: `${unlockedUserId}@example.com`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
          failedLoginCount: 0,
          lockedUntil: null,
        },
        {
          id: deletedUserId,
          userName: "Deleted User",
          userEmail: `${deletedUserId}@example.com`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "DELETED",
          failedLoginCount: 5,
          lockedUntil,
        },
      ]);
    });

    it("admin_user unlocks an ACTIVE locked user and writes a USER_UNLOCKED audit row", async () => {
      mockSession(adminUserId);

      const [before] = await db
        .select({ lastModifiedDatetime: appuser.lastModifiedDatetime })
        .from(appuser)
        .where(eq(appuser.id, lockedActiveUserId));

      const result = await unlockAccountAction({
        userId: lockedActiveUserId,
      });

      expect(result).toEqual({ ok: true });

      const [userRow] = await db
        .select()
        .from(appuser)
        .where(eq(appuser.id, lockedActiveUserId));
      expect(userRow?.failedLoginCount).toBe(0);
      expect(userRow?.lockedUntil).toBeNull();
      expect(userRow?.lastModifiedDatetime.getTime()).toBeGreaterThan(
        before!.lastModifiedDatetime.getTime(),
      );

      const [auditRow] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, lockedActiveUserId));
      expect(auditRow?.eventType).toBe("USER_UNLOCKED");
      expect(auditRow?.actorUserId).toBe(adminUserId);
      expect(auditRow?.targetEntity).toBe("APPUSER");
      expect(auditRow?.beforeData).toMatchObject({ failedLoginCount: 5 });
      expect(auditRow?.afterData).toEqual({
        failedLoginCount: 0,
        lockedUntil: null,
      });
    });

    it("admin_user unlocks a PENDING locked user", async () => {
      mockSession(adminUserId);

      const result = await unlockAccountAction({
        userId: lockedPendingUserId,
      });

      expect(result).toEqual({ ok: true });

      const [userRow] = await db
        .select()
        .from(appuser)
        .where(eq(appuser.id, lockedPendingUserId));
      expect(userRow?.failedLoginCount).toBe(0);
      expect(userRow?.lockedUntil).toBeNull();

      const [auditRow] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, lockedPendingUserId));
      expect(auditRow?.eventType).toBe("USER_UNLOCKED");
    });

    it("admin_user unlocks a DISABLED locked user", async () => {
      mockSession(adminUserId);

      const result = await unlockAccountAction({
        userId: lockedDisabledUserId,
      });

      expect(result).toEqual({ ok: true });

      const [userRow] = await db
        .select()
        .from(appuser)
        .where(eq(appuser.id, lockedDisabledUserId));
      expect(userRow?.failedLoginCount).toBe(0);
      expect(userRow?.lockedUntil).toBeNull();

      const [auditRow] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, lockedDisabledUserId));
      expect(auditRow?.eventType).toBe("USER_UNLOCKED");
    });

    it("returns NOT_LOCKED for a user who is not currently locked, with no writes", async () => {
      mockSession(adminUserId);

      const result = await unlockAccountAction({ userId: unlockedUserId });

      expect(result).toEqual({ ok: false, code: "NOT_LOCKED" });

      const auditRows = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, unlockedUserId));
      expect(auditRows).toHaveLength(0);
    });

    it("returns NOT_LOCKED for an expired lock (race condition), leaving the row unchanged", async () => {
      mockSession(adminUserId);
      const expired = new Date(Date.now() - 1000);
      await db
        .update(appuser)
        .set({ lockedUntil: expired })
        .where(eq(appuser.id, lockedActiveUserId));

      const result = await unlockAccountAction({
        userId: lockedActiveUserId,
      });

      expect(result).toEqual({ ok: false, code: "NOT_LOCKED" });

      const [userRow] = await db
        .select()
        .from(appuser)
        .where(eq(appuser.id, lockedActiveUserId));
      expect(userRow?.failedLoginCount).toBe(5);
      expect(userRow?.lockedUntil?.getTime()).toBe(expired.getTime());

      const auditRows = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, lockedActiveUserId));
      expect(auditRows).toHaveLength(0);
    });

    it("returns INVALID_STATE for a DELETED user, with no writes", async () => {
      mockSession(adminUserId);

      const result = await unlockAccountAction({ userId: deletedUserId });

      expect(result).toEqual({ ok: false, code: "INVALID_STATE" });

      const auditRows = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, deletedUserId));
      expect(auditRows).toHaveLength(0);
    });

    it("returns USER_NOT_FOUND for a non-existent userId", async () => {
      mockSession(adminUserId);

      const result = await unlockAccountAction({ userId: randomUUID() });

      expect(result).toEqual({ ok: false, code: "USER_NOT_FOUND" });
    });

    it("no_grants_user is forbidden, leaving the account unchanged", async () => {
      mockSession(noGrantsUserId);

      const result = await unlockAccountAction({
        userId: lockedActiveUserId,
      });

      expect(result).toEqual({ ok: false, code: "FORBIDDEN" });

      const [userRow] = await db
        .select()
        .from(appuser)
        .where(eq(appuser.id, lockedActiveUserId));
      expect(userRow?.failedLoginCount).toBe(5);
      expect(userRow?.lockedUntil).not.toBeNull();
    });

    it("an unauthenticated caller is forbidden", async () => {
      mockSession(null);

      const result = await unlockAccountAction({
        userId: lockedActiveUserId,
      });

      expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    });
  },
);
