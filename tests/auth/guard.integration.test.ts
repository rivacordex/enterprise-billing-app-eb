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

import { appuser, session as sessionTable } from "@/db/schema/identity";
import { roles } from "@/db/schema/roles";
import { permissions } from "@/db/schema/permissions";
import { rolePermissionAssign } from "@/db/schema/role-permission-assign";
import { roleAssign } from "@/db/schema/role-assign";
import { PERMISSIONS, LEVELS } from "@/auth/permission-constants";
import type {
  requirePermission as RequirePermission,
  requireAuthenticated as RequireAuthenticated,
  resolveForcePasswordChangeSession as ResolveForcePasswordChangeSession,
} from "@/auth/guard";
import type { PermissionName, PermissionType } from "@/types/rbac";

// Exercises the real `auth/guard.ts` against a live Postgres database.
// `@/auth` is replaced with a fake exposing only `api.getSession` — the one
// member `auth/guard.ts` calls — so the guard's own session-aware logic
// runs for real while the controlled session comes from the test. `@/auth`
// and `@/auth/guard` are imported dynamically inside `beforeAll`, after
// confirming `DATABASE_URL` is set, mirroring
// tests/auth/signin-lockout.integration.test.ts (um06-spec §6.10).
const databaseUrl = process.env.DATABASE_URL;

const getSessionMock = vi.fn();
vi.mock("@/auth", () => ({
  auth: { api: { getSession: getSessionMock } },
}));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

// Next's `redirect()` throws an `Error` whose `digest` encodes
// `NEXT_REDIRECT;<type>;<url>;<statusCode>;` — the same mechanism
// `getURLFromRedirectError` reads internally (not exported from the public
// `next/navigation` entry point), parsed here directly.
function redirectTarget(error: unknown): string | null {
  if (
    !(error instanceof Error) ||
    typeof (error as { digest?: unknown }).digest !== "string"
  ) {
    return null;
  }
  const parts = (error as Error & { digest: string }).digest.split(";");
  if (parts[0] !== "NEXT_REDIRECT") return null;
  return parts.slice(2, -2).join(";");
}

describe.skipIf(!databaseUrl)(
  "requirePermission / requireAuthenticated (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle>;
    let requirePermission: typeof RequirePermission;
    let requireAuthenticated: typeof RequireAuthenticated;
    let resolveForcePasswordChangeSession: typeof ResolveForcePasswordChangeSession;

    let adminUserId: string;
    let noGrantsUserId: string;
    let pendingUserId: string;
    let disabledUserId: string;
    let forcePasswordChangeUserId: string;
    let pendingForceChangeUserId: string;

    async function insertUser(params: {
      id: string;
      status?: "ACTIVE" | "PENDING" | "DISABLED";
      forcePasswordChange?: boolean;
    }): Promise<void> {
      await db.insert(appuser).values({
        id: params.id,
        userName: "Test User",
        userEmail: `${params.id}@example.com`,
        emailVerified: false,
        authMethod: "LOCAL",
        status: params.status ?? "ACTIVE",
        forcePasswordChange: params.forcePasswordChange ?? false,
      });
    }

    beforeAll(async () => {
      sql = postgres(databaseUrl as string, { max: 1 });
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      db = drizzle(sql);
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      ({
        requirePermission,
        requireAuthenticated,
        resolveForcePasswordChangeSession,
      } = await import("@/auth/guard"));

      adminUserId = randomUUID();
      noGrantsUserId = randomUUID();
      pendingUserId = randomUUID();
      disabledUserId = randomUUID();
      forcePasswordChangeUserId = randomUUID();
      pendingForceChangeUserId = randomUUID();

      await insertUser({ id: adminUserId });
      await insertUser({ id: noGrantsUserId });
      await insertUser({ id: pendingUserId, status: "PENDING" });
      await insertUser({ id: disabledUserId, status: "DISABLED" });
      await insertUser({
        id: forcePasswordChangeUserId,
        forcePasswordChange: true,
      });
      await insertUser({
        id: pendingForceChangeUserId,
        status: "PENDING",
        forcePasswordChange: true,
      });

      const [adminRole] = await db
        .insert(roles)
        .values({ roleName: "ADMIN", roleDescr: "Admin" })
        .returning({ roleId: roles.roleId });

      const insertedPermissions = await db
        .insert(permissions)
        .values([
          { permissionName: "users", permissionInfo: "Users" },
          { permissionName: "roles", permissionInfo: "Roles" },
          { permissionName: "system_config", permissionInfo: "Config" },
          { permissionName: "audit_log", permissionInfo: "Audit" },
        ])
        .returning({
          permissionId: permissions.permissionId,
          permissionName: permissions.permissionName,
        });

      const permissionIdByName = new Map(
        insertedPermissions.map((p) => [p.permissionName, p.permissionId]),
      );

      const grants: { name: PermissionName; type: PermissionType }[] = [
        { name: "users", type: "DELETE" },
        { name: "roles", type: "DELETE" },
        { name: "system_config", type: "DELETE" },
        { name: "audit_log", type: "READ" },
      ];

      await db.insert(rolePermissionAssign).values(
        grants.map((g) => ({
          refRoleId: adminRole!.roleId,
          refPermissionId: permissionIdByName.get(g.name)!,
          permissionType: g.type,
        })),
      );

      await db.insert(roleAssign).values({
        refUserId: adminUserId,
        refRoleId: adminRole!.roleId,
        assignedBy: null,
      });
    }, 30_000);

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    beforeEach(() => {
      getSessionMock.mockReset();
    });

    function mockSession(userId: string | null): void {
      getSessionMock.mockResolvedValue(
        userId ? { user: { id: userId } } : null,
      );
    }

    describe("requirePermission", () => {
      it.each([
        [PERMISSIONS.USERS, LEVELS.READ],
        [PERMISSIONS.USERS, LEVELS.EDIT],
        [PERMISSIONS.USERS, LEVELS.DELETE],
        [PERMISSIONS.ROLES, LEVELS.READ],
        [PERMISSIONS.ROLES, LEVELS.EDIT],
        [PERMISSIONS.ROLES, LEVELS.DELETE],
        [PERMISSIONS.SYSTEM_CONFIG, LEVELS.READ],
        [PERMISSIONS.SYSTEM_CONFIG, LEVELS.EDIT],
        [PERMISSIONS.SYSTEM_CONFIG, LEVELS.DELETE],
        [PERMISSIONS.AUDIT_LOG, LEVELS.READ],
      ] as const)("admin_user satisfies %s:%s", async (name, level) => {
        mockSession(adminUserId);
        const result = await requirePermission(name, level);
        expect(result.userId).toBe(adminUserId);
        expect(result.permissionMap[name]).not.toBeNull();
      });

      it("admin_user is denied audit_log:EDIT (only READ granted)", async () => {
        mockSession(adminUserId);
        await expect(
          requirePermission(PERMISSIONS.AUDIT_LOG, LEVELS.EDIT),
        ).rejects.toSatisfy(
          (err: unknown) => redirectTarget(err) === "/no-access",
        );
      });

      it.each([
        PERMISSIONS.USERS,
        PERMISSIONS.ROLES,
        PERMISSIONS.SYSTEM_CONFIG,
        PERMISSIONS.AUDIT_LOG,
      ])("no_grants_user is denied %s:READ", async (name) => {
        mockSession(noGrantsUserId);
        await expect(requirePermission(name, LEVELS.READ)).rejects.toSatisfy(
          (err: unknown) => redirectTarget(err) === "/no-access",
        );
      });

      it("redirects a PENDING user to /login and deletes their sessions", async () => {
        await db.insert(sessionTable).values({
          id: randomUUID(),
          userId: pendingUserId,
          sessionToken: randomUUID(),
          expiresAt: new Date(Date.now() + 60_000),
        });
        mockSession(pendingUserId);

        await expect(
          requirePermission(PERMISSIONS.USERS, LEVELS.READ),
        ).rejects.toSatisfy((err: unknown) => redirectTarget(err) === "/login");

        const remaining = await db
          .select()
          .from(sessionTable)
          .where(eq(sessionTable.userId, pendingUserId));
        expect(remaining).toHaveLength(0);
      });

      it("redirects a DISABLED user to /login", async () => {
        mockSession(disabledUserId);
        await expect(
          requirePermission(PERMISSIONS.USERS, LEVELS.READ),
        ).rejects.toSatisfy((err: unknown) => redirectTarget(err) === "/login");
      });

      it("redirects to /login when there is no session", async () => {
        mockSession(null);
        await expect(
          requirePermission(PERMISSIONS.USERS, LEVELS.READ),
        ).rejects.toSatisfy((err: unknown) => redirectTarget(err) === "/login");
      });

      it("redirects to /set-password when force_password_change is true", async () => {
        mockSession(forcePasswordChangeUserId);
        await expect(
          requirePermission(PERMISSIONS.USERS, LEVELS.READ),
        ).rejects.toSatisfy(
          (err: unknown) => redirectTarget(err) === "/set-password",
        );
      });
    });

    describe("requireAuthenticated", () => {
      it("returns context for admin_user", async () => {
        mockSession(adminUserId);
        const result = await requireAuthenticated();
        expect(result.userId).toBe(adminUserId);
      });

      it("returns context for a no-grants ACTIVE user (no permission check)", async () => {
        mockSession(noGrantsUserId);
        const result = await requireAuthenticated();
        expect(result.userId).toBe(noGrantsUserId);
      });

      it("redirects a PENDING user to /login", async () => {
        mockSession(pendingUserId);
        await expect(requireAuthenticated()).rejects.toSatisfy(
          (err: unknown) => redirectTarget(err) === "/login",
        );
      });

      it("redirects to /login when there is no session", async () => {
        mockSession(null);
        await expect(requireAuthenticated()).rejects.toSatisfy(
          (err: unknown) => redirectTarget(err) === "/login",
        );
      });

      it("redirects to /set-password when force_password_change is true", async () => {
        mockSession(forcePasswordChangeUserId);
        await expect(requireAuthenticated()).rejects.toSatisfy(
          (err: unknown) => redirectTarget(err) === "/set-password",
        );
      });
    });

    describe("resolveForcePasswordChangeSession", () => {
      it("redirects to /login when there is no session", async () => {
        mockSession(null);
        await expect(resolveForcePasswordChangeSession()).rejects.toSatisfy(
          (err: unknown) => redirectTarget(err) === "/login",
        );
      });

      it("redirects to /login for a DISABLED user", async () => {
        mockSession(disabledUserId);
        await expect(resolveForcePasswordChangeSession()).rejects.toSatisfy(
          (err: unknown) => redirectTarget(err) === "/login",
        );
      });

      it("redirects to / when force_password_change is false", async () => {
        mockSession(adminUserId);
        await expect(resolveForcePasswordChangeSession()).rejects.toSatisfy(
          (err: unknown) => redirectTarget(err) === "/",
        );
      });

      it("returns the session context for a PENDING user with the flag set", async () => {
        mockSession(pendingForceChangeUserId);
        const result = await resolveForcePasswordChangeSession();
        expect(result).toEqual({
          userId: pendingForceChangeUserId,
          userName: "Test User",
          status: "PENDING",
        });
      });

      it("returns the session context for an already-ACTIVE user (admin reset)", async () => {
        mockSession(forcePasswordChangeUserId);
        const result = await resolveForcePasswordChangeSession();
        expect(result).toEqual({
          userId: forcePasswordChangeUserId,
          userName: "Test User",
          status: "ACTIVE",
        });
      });
    });
  },
);
