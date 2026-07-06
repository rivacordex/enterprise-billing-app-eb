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
import type { switchAuthMethodAction as SwitchAuthMethodAction } from "@/actions/users/switch-auth-method.action";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// Exercises the real `switchAuthMethodAction` (guard + validation + service)
// against a live Postgres database, mirroring
// tests/actions/reset-password.action.integration.test.ts.
const databaseUrl = process.env.DATABASE_URL;

const OLD_PASSWORD = "old-temp-password-123";
const FUTURE_LOCK = new Date(Date.now() + 15 * 60 * 1000);

const getSessionMock = vi.fn();
vi.mock("@/auth", () => ({
  auth: { api: { getSession: getSessionMock } },
}));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

describe.skipIf(!databaseUrl)(
  "switchAuthMethodAction (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let switchAuthMethodAction: typeof SwitchAuthMethodAction;

    let adminUserId: string;
    let noGrantsUserId: string;

    let ssoActiveUserId: string;
    let ssoPendingUserId: string;
    let localActiveUserId: string;

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

      ({ switchAuthMethodAction } =
        await import("@/actions/users/switch-auth-method.action"));

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
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    beforeEach(async () => {
      getSessionMock.mockReset();
      const hashedPassword = await hashPassword(OLD_PASSWORD);

      ssoActiveUserId = randomUUID();
      ssoPendingUserId = randomUUID();
      localActiveUserId = randomUUID();

      await db.insert(appuser).values([
        {
          id: ssoActiveUserId,
          userName: "SSO Active User",
          userEmail: `${ssoActiveUserId}@example.com`,
          emailVerified: false,
          authMethod: "SSO",
          status: "ACTIVE",
          forcePasswordChange: false,
        },
        {
          id: ssoPendingUserId,
          userName: "SSO Pending User",
          userEmail: `${ssoPendingUserId}@example.com`,
          emailVerified: false,
          authMethod: "SSO",
          status: "PENDING",
          forcePasswordChange: false,
        },
        {
          id: localActiveUserId,
          userName: "Local Active User",
          userEmail: `${localActiveUserId}@example.com`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
          forcePasswordChange: true,
          failedLoginCount: 5,
          lockedUntil: FUTURE_LOCK,
        },
      ]);

      await db.insert(account).values([
        {
          id: randomUUID(),
          userId: ssoActiveUserId,
          providerId: "microsoft",
          providerAccountId: `entra-${ssoActiveUserId}`,
        },
        {
          id: randomUUID(),
          userId: localActiveUserId,
          providerId: "credential",
          providerAccountId: localActiveUserId,
          password: hashedPassword,
        },
      ]);

      // Two sessions for the SSO active user, one for the LOCAL active user.
      await db.insert(session).values([
        {
          id: randomUUID(),
          userId: ssoActiveUserId,
          sessionToken: randomUUID(),
          expiresAt: new Date(Date.now() + 60_000),
        },
        {
          id: randomUUID(),
          userId: ssoActiveUserId,
          sessionToken: randomUUID(),
          expiresAt: new Date(Date.now() + 60_000),
        },
        {
          id: randomUUID(),
          userId: localActiveUserId,
          sessionToken: randomUUID(),
          expiresAt: new Date(Date.now() + 60_000),
        },
      ]);
    });

    it("switches an ACTIVE SSO user to LOCAL: swaps accounts, revokes sessions, and audits", async () => {
      mockSession(adminUserId);

      const result = await switchAuthMethodAction({
        userId: ssoActiveUserId,
        newAuthMethod: "LOCAL",
      });

      expect(result.ok).toBe(true);
      if (!result.ok || result.newAuthMethod !== "LOCAL") {
        throw new Error("expected SSO → LOCAL success");
      }
      expect(result.tempPassword.length).toBeGreaterThan(0);

      const [userRow] = await db
        .select()
        .from(appuser)
        .where(eq(appuser.id, ssoActiveUserId));
      expect(userRow?.authMethod).toBe("LOCAL");
      expect(userRow?.forcePasswordChange).toBe(true);

      const credentialRows = await db
        .select()
        .from(account)
        .where(
          and(
            eq(account.userId, ssoActiveUserId),
            eq(account.providerId, "credential"),
          ),
        );
      expect(credentialRows).toHaveLength(1);
      const newVerifies = await verifyPassword({
        hash: credentialRows[0]!.password!,
        password: result.tempPassword,
      });
      expect(newVerifies).toBe(true);

      const microsoftRows = await db
        .select()
        .from(account)
        .where(
          and(
            eq(account.userId, ssoActiveUserId),
            eq(account.providerId, "microsoft"),
          ),
        );
      expect(microsoftRows).toHaveLength(0);

      const sessions = await db
        .select()
        .from(session)
        .where(eq(session.userId, ssoActiveUserId));
      expect(sessions).toHaveLength(0);

      const [auditRow] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, ssoActiveUserId));
      expect(auditRow?.eventType).toBe("USER_AUTH_METHOD_CHANGED");
      expect(auditRow?.actorUserId).toBe(adminUserId);
      expect(auditRow?.beforeData).toEqual({ authMethod: "SSO" });
      expect(auditRow?.afterData).toEqual({
        authMethod: "LOCAL",
        sessionsRevoked: 2,
      });
      const serializedAudit = JSON.stringify(auditRow);
      expect(serializedAudit).not.toContain(result.tempPassword);
      expect(serializedAudit).not.toContain(credentialRows[0]!.password);
    });

    it("switches a PENDING SSO user (no microsoft row, no sessions) to LOCAL without error", async () => {
      mockSession(adminUserId);

      const result = await switchAuthMethodAction({
        userId: ssoPendingUserId,
        newAuthMethod: "LOCAL",
      });

      expect(result.ok).toBe(true);

      const credentialRows = await db
        .select()
        .from(account)
        .where(
          and(
            eq(account.userId, ssoPendingUserId),
            eq(account.providerId, "credential"),
          ),
        );
      expect(credentialRows).toHaveLength(1);

      const [auditRow] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, ssoPendingUserId));
      expect(auditRow?.afterData).toEqual({
        authMethod: "LOCAL",
        sessionsRevoked: 0,
      });
    });

    it("switches a LOCAL user with lockout to SSO: removes the credential, clears lockout, revokes sessions", async () => {
      mockSession(adminUserId);

      const result = await switchAuthMethodAction({
        userId: localActiveUserId,
        newAuthMethod: "SSO",
      });

      expect(result).toEqual({ ok: true, newAuthMethod: "SSO" });

      const [userRow] = await db
        .select()
        .from(appuser)
        .where(eq(appuser.id, localActiveUserId));
      expect(userRow?.authMethod).toBe("SSO");
      expect(userRow?.forcePasswordChange).toBe(false);
      expect(userRow?.failedLoginCount).toBe(0);
      expect(userRow?.lockedUntil).toBeNull();

      const credentialRows = await db
        .select()
        .from(account)
        .where(
          and(
            eq(account.userId, localActiveUserId),
            eq(account.providerId, "credential"),
          ),
        );
      expect(credentialRows).toHaveLength(0);

      const sessions = await db
        .select()
        .from(session)
        .where(eq(session.userId, localActiveUserId));
      expect(sessions).toHaveLength(0);

      const [auditRow] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, localActiveUserId));
      expect(auditRow?.eventType).toBe("USER_AUTH_METHOD_CHANGED");
      expect(auditRow?.beforeData).toEqual({ authMethod: "LOCAL" });
      expect(auditRow?.afterData).toEqual({
        authMethod: "SSO",
        sessionsRevoked: 1,
      });
    });

    it("returns ALREADY_METHOD when switching to the current method, with no writes", async () => {
      mockSession(adminUserId);

      const result = await switchAuthMethodAction({
        userId: ssoActiveUserId,
        newAuthMethod: "SSO",
      });

      expect(result).toEqual({ ok: false, code: "ALREADY_METHOD" });

      const [userRow] = await db
        .select()
        .from(appuser)
        .where(eq(appuser.id, ssoActiveUserId));
      expect(userRow?.authMethod).toBe("SSO");

      const auditRows = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, ssoActiveUserId));
      expect(auditRows).toHaveLength(0);
    });

    it("returns USER_NOT_FOUND for a non-existent userId", async () => {
      mockSession(adminUserId);

      const result = await switchAuthMethodAction({
        userId: randomUUID(),
        newAuthMethod: "LOCAL",
      });

      expect(result).toEqual({ ok: false, code: "USER_NOT_FOUND" });
    });

    it("no_grants_user is forbidden, leaving the account unchanged", async () => {
      mockSession(noGrantsUserId);

      const result = await switchAuthMethodAction({
        userId: ssoActiveUserId,
        newAuthMethod: "LOCAL",
      });

      expect(result).toEqual({ ok: false, code: "FORBIDDEN" });

      const [userRow] = await db
        .select()
        .from(appuser)
        .where(eq(appuser.id, ssoActiveUserId));
      expect(userRow?.authMethod).toBe("SSO");
    });

    it("an unauthenticated caller is forbidden", async () => {
      mockSession(null);

      const result = await switchAuthMethodAction({
        userId: ssoActiveUserId,
        newAuthMethod: "LOCAL",
      });

      expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    });
  },
);
