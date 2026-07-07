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
import { hashPassword, verifyPassword } from "better-auth/crypto";

import * as schema from "@/db/schema";
import { account, appuser, session } from "@/db/schema/identity";
import { auditLog } from "@/db/schema/audit";
import { roles } from "@/db/schema/roles";
import { permissions } from "@/db/schema/permissions";
import { rolePermissionAssign } from "@/db/schema/role-permission-assign";
import { roleAssign } from "@/db/schema/role-assign";
import type { resetPasswordAction as ResetPasswordAction } from "@/actions/users/reset-password.action";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// Exercises the real `resetPasswordAction` (guard + validation + service)
// against a live Postgres database, mirroring
// tests/actions/disable-enable-user.action.integration.test.ts.
const databaseUrl = process.env.DATABASE_URL;

const OLD_PASSWORD = "old-temp-password-123";

const getSessionMock = vi.fn();
vi.mock("@/auth", () => ({
  auth: { api: { getSession: getSessionMock } },
}));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

describe.skipIf(!databaseUrl)(
  "resetPasswordAction (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let resetPasswordAction: typeof ResetPasswordAction;

    let adminUserId: string;
    let noGrantsUserId: string;
    let localActiveUserId: string;
    let localDisabledUserId: string;
    let localDeletedUserId: string;
    let ssoUserId: string;

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

      ({ resetPasswordAction } =
        await import("@/actions/users/reset-password.action"));

      adminUserId = randomUUID();
      noGrantsUserId = randomUUID();
      ssoUserId = randomUUID();

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
        {
          id: ssoUserId,
          userName: "SSO User",
          userEmail: `${ssoUserId}@example.com`,
          emailVerified: false,
          authMethod: "SSO",
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
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    beforeEach(async () => {
      getSessionMock.mockReset();
      const hashedPassword = await hashPassword(OLD_PASSWORD);

      localActiveUserId = randomUUID();
      localDisabledUserId = randomUUID();
      localDeletedUserId = randomUUID();

      await db.insert(appuser).values([
        {
          id: localActiveUserId,
          userName: "Local Active User",
          userEmail: `${localActiveUserId}@example.com`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
          forcePasswordChange: false,
        },
        {
          id: localDisabledUserId,
          userName: "Local Disabled User",
          userEmail: `${localDisabledUserId}@example.com`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "DISABLED",
          forcePasswordChange: false,
        },
        {
          id: localDeletedUserId,
          userName: "Local Deleted User",
          userEmail: `${localDeletedUserId}@example.com`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "DELETED",
          forcePasswordChange: false,
        },
      ]);

      await db.insert(account).values([
        {
          id: randomUUID(),
          userId: localActiveUserId,
          providerId: "credential",
          providerAccountId: localActiveUserId,
          password: hashedPassword,
        },
        {
          id: randomUUID(),
          userId: localDisabledUserId,
          providerId: "credential",
          providerAccountId: localDisabledUserId,
          password: hashedPassword,
        },
      ]);

      await db.insert(session).values({
        id: randomUUID(),
        userId: localActiveUserId,
        sessionToken: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      });
    });

    it("admin_user resets an ACTIVE LOCAL user's password, revokes sessions, and writes a USER_PASSWORD_RESET audit row", async () => {
      mockSession(adminUserId);

      const [before] = await db
        .select({ lastModifiedDatetime: appuser.lastModifiedDatetime })
        .from(appuser)
        .where(eq(appuser.id, localActiveUserId));

      const result = await resetPasswordAction({ userId: localActiveUserId });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok: true");
      expect(result.tempPassword.length).toBeGreaterThan(0);
      expect(result.tempPassword).not.toBe(OLD_PASSWORD);

      const [accountRow] = await db
        .select()
        .from(account)
        .where(
          and(
            eq(account.userId, localActiveUserId),
            eq(account.providerId, "credential"),
          ),
        );
      expect(accountRow?.password).not.toBeNull();
      const oldStillVerifies = await verifyPassword({
        hash: accountRow!.password!,
        password: OLD_PASSWORD,
      });
      expect(oldStillVerifies).toBe(false);
      const newVerifies = await verifyPassword({
        hash: accountRow!.password!,
        password: result.tempPassword,
      });
      expect(newVerifies).toBe(true);

      const [userRow] = await db
        .select()
        .from(appuser)
        .where(eq(appuser.id, localActiveUserId));
      expect(userRow?.forcePasswordChange).toBe(true);
      expect(userRow?.lastModifiedDatetime.getTime()).toBeGreaterThan(
        before!.lastModifiedDatetime.getTime(),
      );

      const sessions = await db
        .select()
        .from(session)
        .where(eq(session.userId, localActiveUserId));
      expect(sessions).toHaveLength(0);

      const [auditRow] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, localActiveUserId));
      expect(auditRow?.eventType).toBe("USER_PASSWORD_RESET");
      expect(auditRow?.actorUserId).toBe(adminUserId);
      expect(auditRow?.targetEntity).toBe("APPUSER");
      expect(auditRow?.beforeData).toEqual({ forcePasswordChange: false });
      expect(auditRow?.afterData).toEqual({ forcePasswordChange: true });
      const serializedAudit = JSON.stringify(auditRow);
      expect(serializedAudit).not.toContain(result.tempPassword);
      expect(serializedAudit).not.toContain(accountRow!.password);
    });

    it("admin_user resets a DISABLED LOCAL user's password", async () => {
      mockSession(adminUserId);

      const result = await resetPasswordAction({
        userId: localDisabledUserId,
      });

      expect(result.ok).toBe(true);

      const [userRow] = await db
        .select()
        .from(appuser)
        .where(eq(appuser.id, localDisabledUserId));
      expect(userRow?.forcePasswordChange).toBe(true);

      const [auditRow] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, localDisabledUserId));
      expect(auditRow?.eventType).toBe("USER_PASSWORD_RESET");
    });

    it("returns NOT_LOCAL_USER for an SSO user, with no writes", async () => {
      mockSession(adminUserId);

      const result = await resetPasswordAction({ userId: ssoUserId });

      expect(result).toEqual({ ok: false, code: "NOT_LOCAL_USER" });

      const auditRows = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, ssoUserId));
      expect(auditRows).toHaveLength(0);
    });

    it("returns INVALID_STATE for a DELETED user, with no writes", async () => {
      mockSession(adminUserId);

      const result = await resetPasswordAction({ userId: localDeletedUserId });

      expect(result).toEqual({ ok: false, code: "INVALID_STATE" });

      const auditRows = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, localDeletedUserId));
      expect(auditRows).toHaveLength(0);
    });

    it("returns USER_NOT_FOUND for a non-existent userId", async () => {
      mockSession(adminUserId);

      const result = await resetPasswordAction({ userId: randomUUID() });

      expect(result).toEqual({ ok: false, code: "USER_NOT_FOUND" });
    });

    it("no_grants_user is forbidden, leaving the account unchanged", async () => {
      mockSession(noGrantsUserId);

      const [before] = await db
        .select({ password: account.password })
        .from(account)
        .where(
          and(
            eq(account.userId, localActiveUserId),
            eq(account.providerId, "credential"),
          ),
        );

      const result = await resetPasswordAction({ userId: localActiveUserId });

      expect(result).toEqual({ ok: false, code: "FORBIDDEN" });

      const [after] = await db
        .select({ password: account.password })
        .from(account)
        .where(
          and(
            eq(account.userId, localActiveUserId),
            eq(account.providerId, "credential"),
          ),
        );
      expect(after?.password).toBe(before?.password);
    });

    it("an unauthenticated caller is forbidden", async () => {
      mockSession(null);

      const result = await resetPasswordAction({ userId: localActiveUserId });

      expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    });
  },
);
