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
import { appuser } from "@/db/schema/identity";
import { auditLog } from "@/db/schema/audit";
import { roles } from "@/db/schema/roles";
import { permissions } from "@/db/schema/permissions";
import { rolePermissionAssign } from "@/db/schema/role-permission-assign";
import { roleAssign } from "@/db/schema/role-assign";
import type { setPermissionMappingAction as SetPermissionMappingAction } from "@/actions/roles/set-permission-level.action";

// Exercises the real `setPermissionMappingAction` (guard + validation +
// service + revalidatePath) against a live Postgres database, mirroring
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
  "setPermissionMappingAction (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let setPermissionMappingAction: typeof SetPermissionMappingAction;

    let adminUserId: string;
    let noGrantsUserId: string;
    let adminRoleId: string;
    let managerRoleId: string;
    let usersPermId: string;
    let rolesPermId: string;
    let auditLogPermId: string;

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

      ({ setPermissionMappingAction } =
        await import("@/actions/roles/set-permission-level.action"));

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
        ])
        .returning({ roleId: roles.roleId, roleName: roles.roleName });
      adminRoleId = insertedRoles.find((r) => r.roleName === "ADMIN")!.roleId;
      managerRoleId = insertedRoles.find(
        (r) => r.roleName === "MANAGER",
      )!.roleId;

      const insertedPermissions = await db
        .insert(permissions)
        .values([
          { permissionName: "users", permissionInfo: "Users" },
          { permissionName: "roles", permissionInfo: "Roles" },
          { permissionName: "audit_log", permissionInfo: "Audit" },
        ])
        .returning({
          permissionId: permissions.permissionId,
          permissionName: permissions.permissionName,
        });
      usersPermId = insertedPermissions.find(
        (p) => p.permissionName === "users",
      )!.permissionId;
      rolesPermId = insertedPermissions.find(
        (p) => p.permissionName === "roles",
      )!.permissionId;
      auditLogPermId = insertedPermissions.find(
        (p) => p.permissionName === "audit_log",
      )!.permissionId;

      await db.insert(rolePermissionAssign).values([
        {
          refRoleId: adminRoleId,
          refPermissionId: rolesPermId,
          permissionType: "DELETE",
        },
        {
          refRoleId: adminRoleId,
          refPermissionId: auditLogPermId,
          permissionType: "READ",
        },
      ]);

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

    beforeEach(() => {
      getSessionMock.mockReset();
    });

    it("admin_user adds a new MANAGER users:READ mapping and writes a PERMISSION_MAPPING_CHANGED audit row", async () => {
      mockSession(adminUserId);

      const result = await setPermissionMappingAction({
        roleId: managerRoleId,
        permissionName: "users",
        level: "READ",
      });

      expect(result).toEqual({ ok: true });

      const [mappingRow] = await db
        .select()
        .from(rolePermissionAssign)
        .where(eq(rolePermissionAssign.refRoleId, managerRoleId));
      expect(mappingRow?.permissionType).toBe("READ");
      expect(mappingRow?.refPermissionId).toBe(usersPermId);

      const [auditRow] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, managerRoleId));
      expect(auditRow?.eventType).toBe("PERMISSION_MAPPING_CHANGED");
      expect(auditRow?.actorUserId).toBe(adminUserId);
      expect(auditRow?.targetEntity).toBe("ROLE_PERMISSION_ASSIGN");
      expect(auditRow?.beforeData).toEqual({
        roleName: "MANAGER",
        permissionName: "users",
        level: null,
      });
      expect(auditRow?.afterData).toEqual({
        roleName: "MANAGER",
        permissionName: "users",
        level: "READ",
      });
    });

    it("admin_user downgrades ADMIN roles from DELETE to READ; exactly one row remains", async () => {
      mockSession(adminUserId);

      const result = await setPermissionMappingAction({
        roleId: adminRoleId,
        permissionName: "roles",
        level: "READ",
      });

      expect(result).toEqual({ ok: true });

      const rows = await db
        .select()
        .from(rolePermissionAssign)
        .where(eq(rolePermissionAssign.refRoleId, adminRoleId));
      const rolesRow = rows.find((r) => r.refPermissionId === rolesPermId);
      expect(rolesRow?.permissionType).toBe("READ");
      expect(
        rows.filter((r) => r.refPermissionId === rolesPermId),
      ).toHaveLength(1);
    });

    it("admin_user removes the ADMIN roles mapping (level -> null)", async () => {
      mockSession(adminUserId);

      // Restore the `roles` mapping to DELETE first so this test is
      // independent of run order — filtered by permission too, since ADMIN
      // also carries an unrelated `audit_log` row under the same roleId.
      await db
        .update(rolePermissionAssign)
        .set({ permissionType: "DELETE" })
        .where(
          and(
            eq(rolePermissionAssign.refRoleId, adminRoleId),
            eq(rolePermissionAssign.refPermissionId, rolesPermId),
          ),
        );

      const result = await setPermissionMappingAction({
        roleId: adminRoleId,
        permissionName: "roles",
        level: null,
      });

      expect(result).toEqual({ ok: true });

      const rows = await db
        .select()
        .from(rolePermissionAssign)
        .where(eq(rolePermissionAssign.refRoleId, adminRoleId));
      expect(
        rows.filter((r) => r.refPermissionId === rolesPermId),
      ).toHaveLength(0);

      // Re-seed for subsequent tests.
      await db.insert(rolePermissionAssign).values({
        refRoleId: adminRoleId,
        refPermissionId: rolesPermId,
        permissionType: "DELETE",
      });
    });

    it("no-change ADMIN audit_log READ -> READ writes no new audit row", async () => {
      mockSession(adminUserId);

      const before = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, adminRoleId));

      const result = await setPermissionMappingAction({
        roleId: adminRoleId,
        permissionName: "audit_log",
        level: "READ",
      });

      expect(result).toEqual({ ok: true });

      const after = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, adminRoleId));
      expect(after).toHaveLength(before.length);
    });

    it("rejects audit_log EDIT with AUDIT_LOG_READONLY; writes nothing", async () => {
      mockSession(adminUserId);

      const beforeAudit = await db.select().from(auditLog);

      const result = await setPermissionMappingAction({
        roleId: adminRoleId,
        permissionName: "audit_log",
        level: "EDIT",
      });

      expect(result).toEqual({ ok: false, code: "AUDIT_LOG_READONLY" });

      const [mappingRow] = await db
        .select()
        .from(rolePermissionAssign)
        .where(eq(rolePermissionAssign.refPermissionId, auditLogPermId));
      expect(mappingRow?.permissionType).toBe("READ");

      const afterAudit = await db.select().from(auditLog);
      expect(afterAudit).toHaveLength(beforeAudit.length);
    });

    it("rejects audit_log DELETE with AUDIT_LOG_READONLY", async () => {
      mockSession(adminUserId);

      const result = await setPermissionMappingAction({
        roleId: adminRoleId,
        permissionName: "audit_log",
        level: "DELETE",
      });

      expect(result).toEqual({ ok: false, code: "AUDIT_LOG_READONLY" });
    });

    it("returns ROLE_NOT_FOUND for a non-existent roleId", async () => {
      mockSession(adminUserId);

      const result = await setPermissionMappingAction({
        roleId: randomUUID(),
        permissionName: "users",
        level: "READ",
      });

      expect(result).toEqual({ ok: false, code: "ROLE_NOT_FOUND" });
    });

    it("no_grants_user is forbidden", async () => {
      mockSession(noGrantsUserId);

      const result = await setPermissionMappingAction({
        roleId: managerRoleId,
        permissionName: "users",
        level: "DELETE",
      });

      expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    });

    it("no session is forbidden", async () => {
      mockSession(null);

      const result = await setPermissionMappingAction({
        roleId: managerRoleId,
        permissionName: "users",
        level: "DELETE",
      });

      expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    });
  },
);
