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
import { account, appuser } from "@/db/schema/identity";
import { auditLog } from "@/db/schema/audit";
import { roles } from "@/db/schema/roles";
import { permissions } from "@/db/schema/permissions";
import { rolePermissionAssign } from "@/db/schema/role-permission-assign";
import { roleAssign } from "@/db/schema/role-assign";
import type { createUserAction as CreateUserAction } from "@/actions/users/create-user.action";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// Exercises the real `createUserAction` (guard + validation + service +
// revalidatePath) against a live Postgres database. `@/auth` is replaced
// with a fake exposing only `api.getSession` — the one member
// `auth/guard.ts` calls — mirroring tests/auth/guard.integration.test.ts.
// `next/cache`'s `revalidatePath` is mocked since it throws outside a real
// Next.js request context.
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
  "createUserAction (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let createUserAction: typeof CreateUserAction;

    let adminUserId: string;
    let noGrantsUserId: string;

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

      ({ createUserAction } =
        await import("@/actions/users/create-user.action"));

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

    beforeEach(() => {
      getSessionMock.mockReset();
    });

    it("admin_user creating a LOCAL user gets a PENDING appuser row, a credential account, and a USER_CREATED audit row", async () => {
      mockSession(adminUserId);
      const email = "new-local-user@example.com";

      const result = await createUserAction({
        userName: "New Local User",
        userEmail: email,
        authMethod: "LOCAL",
        roleIds: [],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok:true");
      expect(result.tempPassword).not.toBeNull();

      const [userRow] = await db
        .select()
        .from(appuser)
        .where(eq(appuser.id, result.userId));
      expect(userRow?.status).toBe("PENDING");
      expect(userRow?.forcePasswordChange).toBe(true);

      const [accountRow] = await db
        .select()
        .from(account)
        .where(eq(account.userId, result.userId));
      expect(accountRow?.providerId).toBe("credential");
      expect(accountRow?.password).toBeTruthy();
      expect(accountRow?.password).not.toBe(result.tempPassword);

      const [auditRow] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, result.userId));
      expect(auditRow?.eventType).toBe("USER_CREATED");
      expect(auditRow?.actorUserId).toBe(adminUserId);
      expect(auditRow?.beforeData).toBeNull();
      expect(
        (auditRow?.afterData as { userEmail?: string } | null)?.userEmail,
      ).toBe(email);
    });

    it("admin_user creating an SSO user gets no account row and a null tempPassword", async () => {
      mockSession(adminUserId);

      const result = await createUserAction({
        userName: "New SSO User",
        userEmail: "new-sso-user@example.com",
        authMethod: "SSO",
        roleIds: [],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok:true");
      expect(result.tempPassword).toBeNull();

      const accountRows = await db
        .select()
        .from(account)
        .where(eq(account.userId, result.userId));
      expect(accountRows).toHaveLength(0);
    });

    it("no_grants_user is forbidden", async () => {
      mockSession(noGrantsUserId);

      const result = await createUserAction({
        userName: "Should Not Be Created",
        userEmail: "forbidden-user@example.com",
        authMethod: "LOCAL",
        roleIds: [],
      });

      expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    });

    it("an unauthenticated caller is forbidden", async () => {
      mockSession(null);

      const result = await createUserAction({
        userName: "Should Not Be Created",
        userEmail: "no-session-user@example.com",
        authMethod: "LOCAL",
        roleIds: [],
      });

      expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    });
  },
);
