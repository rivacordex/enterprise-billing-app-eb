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
import type { createRoleAction as CreateRoleAction } from "@/actions/roles/create-role.action";

// Exercises the real `createRoleAction` (guard + validation + service +
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
  "createRoleAction (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let createRoleAction: typeof CreateRoleAction;

    let adminUserId: string;
    let noGrantsUserId: string;
    let seededAdminRoleId: string;

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

      ({ createRoleAction } =
        await import("@/actions/roles/create-role.action"));

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
      seededAdminRoleId = adminRole!.roleId;

      const [rolesPermission] = await db
        .insert(permissions)
        .values({ permissionName: "roles", permissionInfo: "Roles" })
        .returning({ permissionId: permissions.permissionId });

      await db.insert(rolePermissionAssign).values({
        refRoleId: seededAdminRoleId,
        refPermissionId: rolesPermission!.permissionId,
        permissionType: "EDIT",
      });

      await db.insert(roleAssign).values({
        refUserId: adminUserId,
        refRoleId: seededAdminRoleId,
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

    it("admin_user creates a role, writes a ROLE_CREATED audit row", async () => {
      mockSession(adminUserId);

      const result = await createRoleAction({
        roleName: "Finance",
        roleDescr: "Finance team",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected ok:true");

      const [roleRow] = await db
        .select()
        .from(roles)
        .where(eq(roles.roleId, result.roleId));
      expect(roleRow?.roleName).toBe("Finance");
      expect(roleRow?.roleDescr).toBe("Finance team");

      const [auditRow] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, result.roleId));
      expect(auditRow?.eventType).toBe("ROLE_CREATED");
      expect(auditRow?.actorUserId).toBe(adminUserId);
      expect(auditRow?.targetEntity).toBe("ROLES");
      expect(auditRow?.beforeData).toBeNull();
      expect(auditRow?.afterData).toEqual({
        roleName: "Finance",
        roleDescr: "Finance team",
      });
    });

    it("rejects a duplicate (case-insensitive) role name with no new row", async () => {
      mockSession(adminUserId);

      const result = await createRoleAction({ roleName: "admin" });

      expect(result).toEqual({ ok: false, code: "NAME_CONFLICT" });

      const matches = await db
        .select()
        .from(roles)
        .where(eq(roles.roleName, "admin"));
      expect(matches).toHaveLength(0);
    });

    it("no_grants_user is forbidden", async () => {
      mockSession(noGrantsUserId);

      const result = await createRoleAction({ roleName: "Should Not Exist" });

      expect(result).toEqual({ ok: false, code: "FORBIDDEN" });

      const matches = await db
        .select()
        .from(roles)
        .where(eq(roles.roleName, "Should Not Exist"));
      expect(matches).toHaveLength(0);
    });

    it("an unauthenticated caller is forbidden", async () => {
      mockSession(null);

      const result = await createRoleAction({ roleName: "Should Not Exist" });

      expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    });
  },
);
