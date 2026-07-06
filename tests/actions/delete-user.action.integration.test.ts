import { randomUUID } from "node:crypto";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq, inArray } from "drizzle-orm";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { account, appuser, session } from "@/db/schema/identity";
import { auditLog } from "@/db/schema/audit";
import { roles } from "@/db/schema/roles";
import { permissions } from "@/db/schema/permissions";
import { rolePermissionAssign } from "@/db/schema/role-permission-assign";
import { roleAssign } from "@/db/schema/role-assign";
import * as appUserRepository from "@/db/repositories/appuser.repository";
import type { deleteUserAction as DeleteUserAction } from "@/actions/users/delete-user.action";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// Exercises the real `deleteUserAction` (guard + validation + service) against
// a live Postgres database, mirroring
// tests/actions/switch-auth-method.action.integration.test.ts.
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
  "deleteUserAction (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let deleteUserAction: typeof DeleteUserAction;

    let deleterUserId: string;
    let noGrantsUserId: string;
    let adminRoleId: string;
    let managerRoleId: string;

    // Per-test fixtures.
    let targetUserId: string;
    let targetUserEmail: string;
    let activeUserId: string;
    let targetAdminUserId: string;

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

      ({ deleteUserAction } =
        await import("@/actions/users/delete-user.action"));

      deleterUserId = randomUUID();
      noGrantsUserId = randomUUID();

      await db.insert(appuser).values([
        {
          id: deleterUserId,
          userName: "Deleter User",
          userEmail: `${deleterUserId}@example.com`,
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

      // A non-ADMIN role grants `users:DELETE` to the actor so the last-admin
      // guard scenario stays coherent: the actor is authorized without being
      // counted as an ADMIN, letting `target_admin_user` be the sole ADMIN.
      const [deleterRole] = await db
        .insert(roles)
        .values({ roleName: "USER_DELETER", roleDescr: "Can delete users" })
        .returning({ roleId: roles.roleId });
      const [adminRole] = await db
        .insert(roles)
        .values({ roleName: "ADMIN", roleDescr: "Admin" })
        .returning({ roleId: roles.roleId });
      adminRoleId = adminRole!.roleId;
      // A non-ADMIN role for the atomicity fixture — assigning ADMIN to the
      // target would trip the last-admin guard before the transaction opens.
      const [managerRole] = await db
        .insert(roles)
        .values({ roleName: "MANAGER", roleDescr: "Manager" })
        .returning({ roleId: roles.roleId });
      managerRoleId = managerRole!.roleId;

      const [usersPermission] = await db
        .insert(permissions)
        .values({ permissionName: "users", permissionInfo: "Users" })
        .returning({ permissionId: permissions.permissionId });

      await db.insert(rolePermissionAssign).values({
        refRoleId: deleterRole!.roleId,
        refPermissionId: usersPermission!.permissionId,
        permissionType: "DELETE",
      });

      await db.insert(roleAssign).values({
        refUserId: deleterUserId,
        refRoleId: deleterRole!.roleId,
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

      targetUserId = randomUUID();
      targetUserEmail = `${targetUserId}@example.com`;
      activeUserId = randomUUID();
      targetAdminUserId = randomUUID();

      await db.insert(appuser).values([
        {
          id: targetUserId,
          userName: "Target User",
          userEmail: targetUserEmail,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "DISABLED",
        },
        {
          id: activeUserId,
          userName: "Active User",
          userEmail: `${activeUserId}@example.com`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        },
        {
          id: targetAdminUserId,
          userName: "Target Admin",
          userEmail: `${targetAdminUserId}@example.com`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "DISABLED",
        },
      ]);

      await db.insert(roleAssign).values({
        refUserId: targetAdminUserId,
        refRoleId: adminRoleId,
        assignedBy: null,
      });
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      // Clean up per-test rows so each test starts from the beforeAll baseline.
      // `role_assign` is ON DELETE RESTRICT, so it must be cleared before the
      // appuser rows (account/session cascade on the appuser delete). Any rows
      // a rolled-back tombstone preserved are removed here too.
      const ids = [targetUserId, activeUserId, targetAdminUserId];
      await db.delete(auditLog);
      await db.delete(roleAssign).where(inArray(roleAssign.refUserId, ids));
      await db.delete(appuser).where(inArray(appuser.id, ids));
    });

    it("tombstones a DISABLED user: preserves the row, strips roles/accounts/sessions, and audits", async () => {
      mockSession(deleterUserId);

      // Per spec, target_user has no roles. Give it an account and a residual
      // session to prove both are removed by the tombstone transaction.
      await db.insert(account).values({
        id: randomUUID(),
        userId: targetUserId,
        providerId: "credential",
        providerAccountId: targetUserId,
        password: "hash",
      });
      await db.insert(session).values({
        id: randomUUID(),
        userId: targetUserId,
        sessionToken: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      });

      const [beforeRow] = await db
        .select({ lastModifiedDatetime: appuser.lastModifiedDatetime })
        .from(appuser)
        .where(eq(appuser.id, targetUserId));

      const result = await deleteUserAction({ userId: targetUserId });

      expect(result).toEqual({ ok: true });

      const [userRow] = await db
        .select()
        .from(appuser)
        .where(eq(appuser.id, targetUserId));
      expect(userRow).toBeDefined(); // row preserved, no physical delete
      expect(userRow?.status).toBe("DELETED");
      expect(userRow?.lastModifiedDatetime.getTime()).toBeGreaterThan(
        beforeRow!.lastModifiedDatetime.getTime(),
      );

      const roleRows = await db
        .select()
        .from(roleAssign)
        .where(eq(roleAssign.refUserId, targetUserId));
      expect(roleRows).toHaveLength(0);

      const accountRows = await db
        .select()
        .from(account)
        .where(eq(account.userId, targetUserId));
      expect(accountRows).toHaveLength(0);

      const sessionRows = await db
        .select()
        .from(session)
        .where(eq(session.userId, targetUserId));
      expect(sessionRows).toHaveLength(0);

      const auditRows = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, targetUserId));
      expect(auditRows).toHaveLength(1);
      const auditRow = auditRows[0];
      expect(auditRow?.eventType).toBe("USER_DELETED");
      expect(auditRow?.actorUserId).toBe(deleterUserId);
      expect(auditRow?.targetEntity).toBe("APPUSER");
      expect(auditRow?.beforeData).toEqual({
        userName: "Target User",
        userEmail: targetUserEmail,
        status: "DISABLED",
        roles: [],
      });
      expect(auditRow?.afterData).toEqual({ status: "DELETED" });
    });

    it("returns FORBIDDEN for a user without the DELETE level, leaving the target unchanged", async () => {
      mockSession(noGrantsUserId);

      const result = await deleteUserAction({ userId: targetUserId });

      expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
      const [userRow] = await db
        .select()
        .from(appuser)
        .where(eq(appuser.id, targetUserId));
      expect(userRow?.status).toBe("DISABLED");
    });

    it("returns FORBIDDEN for an unauthenticated caller", async () => {
      mockSession(null);

      const result = await deleteUserAction({ userId: targetUserId });

      expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    });

    it("returns INVALID_STATE for an ACTIVE target without writes", async () => {
      mockSession(deleterUserId);

      const result = await deleteUserAction({ userId: activeUserId });

      expect(result).toEqual({ ok: false, code: "INVALID_STATE" });
      const [userRow] = await db
        .select()
        .from(appuser)
        .where(eq(appuser.id, activeUserId));
      expect(userRow?.status).toBe("ACTIVE");
      const auditRows = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, activeUserId));
      expect(auditRows).toHaveLength(0);
    });

    it("returns LAST_ADMIN when the target is the only remaining ADMIN, leaving everything unchanged", async () => {
      mockSession(deleterUserId);

      const result = await deleteUserAction({ userId: targetAdminUserId });

      expect(result).toEqual({ ok: false, code: "LAST_ADMIN" });

      const [userRow] = await db
        .select()
        .from(appuser)
        .where(eq(appuser.id, targetAdminUserId));
      expect(userRow?.status).toBe("DISABLED");

      const roleRows = await db
        .select()
        .from(roleAssign)
        .where(eq(roleAssign.refUserId, targetAdminUserId));
      expect(roleRows).toHaveLength(1);

      const auditRows = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, targetAdminUserId));
      expect(auditRows).toHaveLength(0);
    });

    it("rolls back every write when a mid-transaction step fails (atomicity)", async () => {
      mockSession(deleterUserId);

      await db.insert(roleAssign).values({
        refUserId: targetUserId,
        refRoleId: managerRoleId,
        assignedBy: null,
      });
      await db.insert(account).values({
        id: randomUUID(),
        userId: targetUserId,
        providerId: "credential",
        providerAccountId: targetUserId,
        password: "hash",
      });

      const spy = vi
        .spyOn(appUserRepository, "deleteAllUserAccounts")
        .mockRejectedValueOnce(new Error("simulated failure"));

      const result = await deleteUserAction({ userId: targetUserId });

      expect(result).toEqual({ ok: false, code: "SERVER_ERROR" });
      expect(spy).toHaveBeenCalled();

      const [userRow] = await db
        .select()
        .from(appuser)
        .where(eq(appuser.id, targetUserId));
      expect(userRow?.status).toBe("DISABLED");

      const roleRows = await db
        .select()
        .from(roleAssign)
        .where(eq(roleAssign.refUserId, targetUserId));
      expect(roleRows).toHaveLength(1);

      const accountRows = await db
        .select()
        .from(account)
        .where(eq(account.userId, targetUserId));
      expect(accountRows).toHaveLength(1);

      const auditRows = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, targetUserId));
      expect(auditRows).toHaveLength(0);
    });

    it("frees the email for reuse after tombstone (partial unique index excludes DELETED)", async () => {
      mockSession(deleterUserId);

      const result = await deleteUserAction({ userId: targetUserId });
      expect(result).toEqual({ ok: true });

      // Inserting a fresh PENDING user with the same email must not violate
      // the partial unique index (which excludes DELETED rows).
      const newUserId = randomUUID();
      await expect(
        db.insert(appuser).values({
          id: newUserId,
          userName: "Reused Email User",
          userEmail: targetUserEmail,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "PENDING",
        }),
      ).resolves.not.toThrow();

      await db.delete(appuser).where(eq(appuser.id, newUserId));
    });
  },
);
