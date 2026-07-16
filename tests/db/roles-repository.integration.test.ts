import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { roles } from "@/db/schema/roles";
import { permissions } from "@/db/schema/permissions";
import { rolePermissionAssign } from "@/db/schema/role-permission-assign";
import { roleAssign } from "@/db/schema/role-assign";
import { appuser } from "@/db/schema/identity";
import { rolesRepository } from "@/db/repositories/roles.repository";
import { rolePermissionAssignRepository } from "@/db/repositories/role-permission-assign.repository";
import { roleAssignRepository } from "@/db/repositories/role-assign.repository";
import { permissionsRepository } from "@/db/repositories/permissions.repository";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import type { PermissionName } from "@/types/rbac";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "rolesRepository / rolePermissionAssignRepository (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let adminRoleId: string;
    let managerRoleId: string;
    let permissionIdByName: Map<string, string>;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      const insertedRoles = await db
        .insert(roles)
        .values([
          { roleName: "USER", roleDescr: null },
          { roleName: "ADMIN", roleDescr: "Full access" },
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
          { permissionName: "system_config", permissionInfo: "Config" },
          { permissionName: "audit_log", permissionInfo: "Audit" },
        ])
        .returning({
          permissionId: permissions.permissionId,
          permissionName: permissions.permissionName,
        });

      permissionIdByName = new Map(
        insertedPermissions.map((p) => [p.permissionName, p.permissionId]),
      );

      await db.insert(rolePermissionAssign).values([
        {
          refRoleId: adminRoleId,
          refPermissionId: permissionIdByName.get("users")!,
          permissionType: "DELETE",
        },
        {
          refRoleId: adminRoleId,
          refPermissionId: permissionIdByName.get("roles")!,
          permissionType: "DELETE",
        },
        {
          refRoleId: adminRoleId,
          refPermissionId: permissionIdByName.get("system_config")!,
          permissionType: "DELETE",
        },
        {
          refRoleId: adminRoleId,
          refPermissionId: permissionIdByName.get("audit_log")!,
          permissionType: "READ",
        },
      ]);
    }, 30_000);

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    describe("rolesRepository.findAll", () => {
      it("returns 3 rows ordered by role_name ascending", async () => {
        const result = await rolesRepository.findAll(db);
        expect(result).toHaveLength(3);
        expect(result.map((r) => r.roleName)).toEqual([
          "ADMIN",
          "MANAGER",
          "USER",
        ]);
      });
    });

    describe("rolesRepository.findRoleById", () => {
      it("returns the ADMIN role row", async () => {
        const result = await rolesRepository.findRoleById(db, adminRoleId);
        expect(result?.roleName).toBe("ADMIN");
      });

      it("returns null for a non-existent role id", async () => {
        const result = await rolesRepository.findRoleById(
          db,
          "00000000-0000-0000-0000-000000000000",
        );
        expect(result).toBeNull();
      });
    });

    describe("rolesRepository.findRoleByName", () => {
      it("returns the ADMIN role row (case-insensitive match)", async () => {
        const result = await rolesRepository.findRoleByName(db, "admin");
        expect(result?.roleId).toBe(adminRoleId);
      });

      it("returns null for a non-existent name", async () => {
        const result = await rolesRepository.findRoleByName(db, "nonexistent");
        expect(result).toBeNull();
      });
    });

    describe("rolesRepository.insertRole / updateRoleNameDescr", () => {
      it("insertRole inserts a row with the given name/descr and a valid roleId", async () => {
        const { roleId } = await rolesRepository.insertRole(db, {
          roleName: "Finance",
          roleDescr: null,
        });

        expect(roleId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );

        const row = await rolesRepository.findRoleById(db, roleId);
        expect(row?.roleName).toBe("Finance");
        expect(row?.roleDescr).toBeNull();
      });

      it("updateRoleNameDescr updates only role_name, role_descr, and last_modified_datetime", async () => {
        const { roleId } = await rolesRepository.insertRole(db, {
          roleName: "Operations",
          roleDescr: "Original",
        });
        const before = await rolesRepository.findRoleById(db, roleId);

        await rolesRepository.updateRoleNameDescr(db, roleId, {
          roleName: "Renamed",
          roleDescr: "Desc",
        });

        const after = await rolesRepository.findRoleById(db, roleId);
        expect(after?.roleName).toBe("Renamed");
        expect(after?.roleDescr).toBe("Desc");
        expect(after?.createdDatetime).toEqual(before?.createdDatetime);
        expect(after?.lastModifiedDatetime.getTime()).toBeGreaterThanOrEqual(
          before!.lastModifiedDatetime.getTime(),
        );
      });

      it("rejects a name that differs only in case from an existing role (DB-level case-insensitive unique index)", async () => {
        await rolesRepository.insertRole(db, {
          roleName: "CaseTest",
          roleDescr: null,
        });

        await expect(
          rolesRepository.insertRole(db, {
            roleName: "CASETEST",
            roleDescr: null,
          }),
        ).rejects.toThrow();
      });
    });

    describe("rolePermissionAssignRepository.findMappingsForRole", () => {
      it("returns 4 entries for ADMIN with correct permissionName/permissionType pairs", async () => {
        const result = await rolePermissionAssignRepository.findMappingsForRole(
          db,
          adminRoleId,
        );
        expect(result).toHaveLength(4);
        expect(
          new Map(result.map((r) => [r.permissionName, r.permissionType])),
        ).toEqual(
          new Map([
            ["users", "DELETE"],
            ["roles", "DELETE"],
            ["system_config", "DELETE"],
            ["audit_log", "READ"],
          ]),
        );
      });

      it("returns [] for MANAGER (no assignments)", async () => {
        const result = await rolePermissionAssignRepository.findMappingsForRole(
          db,
          managerRoleId,
        );
        expect(result).toEqual([]);
      });
    });

    describe("permissionsRepository.findByName", () => {
      it("returns the seeded 'users' Permission row", async () => {
        const result = await permissionsRepository.findByName(db, "users");
        expect(result?.permissionName).toBe("users");
        expect(result?.permissionId).toBe(permissionIdByName.get("users"));
      });

      it("returns the seeded 'roles' Permission row", async () => {
        const result = await permissionsRepository.findByName(db, "roles");
        expect(result?.permissionName).toBe("roles");
      });

      it("returns null for a nonexistent permission_name", async () => {
        const result = await permissionsRepository.findByName(
          db,
          "nonexistent_page" as PermissionName,
        );
        expect(result).toBeNull();
      });
    });

    describe("rolePermissionAssignRepository.upsertRolePermission / deleteRolePermission", () => {
      it("inserts a row when no conflict exists", async () => {
        await rolePermissionAssignRepository.upsertRolePermission(db, {
          roleId: managerRoleId,
          permissionId: permissionIdByName.get("users")!,
          permissionType: "READ",
        });

        const result = await rolePermissionAssignRepository.findMappingsForRole(
          db,
          managerRoleId,
        );
        expect(
          result.find((r) => r.permissionName === "users")?.permissionType,
        ).toBe("READ");
      });

      it("updates permission_type on conflict with no duplicate row", async () => {
        await rolePermissionAssignRepository.upsertRolePermission(db, {
          roleId: managerRoleId,
          permissionId: permissionIdByName.get("users")!,
          permissionType: "EDIT",
        });

        const [row] = await db
          .select()
          .from(rolePermissionAssign)
          .where(
            and(
              eq(rolePermissionAssign.refRoleId, managerRoleId),
              eq(
                rolePermissionAssign.refPermissionId,
                permissionIdByName.get("users")!,
              ),
            ),
          );
        expect(row?.permissionType).toBe("EDIT");

        const rows = await db
          .select()
          .from(rolePermissionAssign)
          .where(
            and(
              eq(rolePermissionAssign.refRoleId, managerRoleId),
              eq(
                rolePermissionAssign.refPermissionId,
                permissionIdByName.get("users")!,
              ),
            ),
          );
        expect(rows).toHaveLength(1);
      });

      it("updates last_modified_datetime on conflict", async () => {
        const [before] = await db
          .select({
            lastModifiedDatetime: rolePermissionAssign.lastModifiedDatetime,
          })
          .from(rolePermissionAssign)
          .where(
            and(
              eq(rolePermissionAssign.refRoleId, managerRoleId),
              eq(
                rolePermissionAssign.refPermissionId,
                permissionIdByName.get("users")!,
              ),
            ),
          );

        await rolePermissionAssignRepository.upsertRolePermission(db, {
          roleId: managerRoleId,
          permissionId: permissionIdByName.get("users")!,
          permissionType: "DELETE",
        });

        const [after] = await db
          .select({
            lastModifiedDatetime: rolePermissionAssign.lastModifiedDatetime,
          })
          .from(rolePermissionAssign)
          .where(
            and(
              eq(rolePermissionAssign.refRoleId, managerRoleId),
              eq(
                rolePermissionAssign.refPermissionId,
                permissionIdByName.get("users")!,
              ),
            ),
          );
        expect(after!.lastModifiedDatetime.getTime()).toBeGreaterThanOrEqual(
          before!.lastModifiedDatetime.getTime(),
        );
      });

      it("deleteRolePermission deletes the target row", async () => {
        await rolePermissionAssignRepository.deleteRolePermission(db, {
          roleId: managerRoleId,
          permissionId: permissionIdByName.get("users")!,
        });

        const rows = await db
          .select()
          .from(rolePermissionAssign)
          .where(
            and(
              eq(rolePermissionAssign.refRoleId, managerRoleId),
              eq(
                rolePermissionAssign.refPermissionId,
                permissionIdByName.get("users")!,
              ),
            ),
          );
        expect(rows).toHaveLength(0);
      });

      it("deleteRolePermission on a non-existent row completes without error (idempotent)", async () => {
        await expect(
          rolePermissionAssignRepository.deleteRolePermission(db, {
            roleId: managerRoleId,
            permissionId: permissionIdByName.get("users")!,
          }),
        ).resolves.toBeUndefined();

        const rows = await db
          .select()
          .from(rolePermissionAssign)
          .where(
            and(
              eq(rolePermissionAssign.refRoleId, managerRoleId),
              eq(
                rolePermissionAssign.refPermissionId,
                permissionIdByName.get("users")!,
              ),
            ),
          );
        expect(rows).toHaveLength(0);
      });
    });

    describe("um21: deleteRoleById / deleteMappingsForRole / countByRoleId", () => {
      it("countByRoleId returns 0 when no assignments exist", async () => {
        const { roleId } = await rolesRepository.insertRole(db, {
          roleName: `NoAssign-${crypto.randomUUID()}`,
          roleDescr: null,
        });

        const count = await roleAssignRepository.countByRoleId(db, roleId);
        expect(count).toBe(0);
      });

      it("countByRoleId counts assignments and increments per assignment", async () => {
        const { roleId } = await rolesRepository.insertRole(db, {
          roleName: `CountTest-${crypto.randomUUID()}`,
          roleDescr: null,
        });

        const [user1] = await db
          .insert(appuser)
          .values({
            id: crypto.randomUUID(),
            userName: "Count User 1",
            userEmail: `${crypto.randomUUID()}@example.com`,
            emailVerified: false,
            authMethod: "LOCAL",
            status: "ACTIVE",
          })
          .returning({ id: appuser.id });
        const [user2] = await db
          .insert(appuser)
          .values({
            id: crypto.randomUUID(),
            userName: "Count User 2",
            userEmail: `${crypto.randomUUID()}@example.com`,
            emailVerified: false,
            authMethod: "LOCAL",
            status: "ACTIVE",
          })
          .returning({ id: appuser.id });

        await db.insert(roleAssign).values({
          refUserId: user1!.id,
          refRoleId: roleId,
          assignedBy: null,
        });
        expect(await roleAssignRepository.countByRoleId(db, roleId)).toBe(1);

        await db.insert(roleAssign).values({
          refUserId: user2!.id,
          refRoleId: roleId,
          assignedBy: null,
        });
        expect(await roleAssignRepository.countByRoleId(db, roleId)).toBe(2);
      });

      it("deleteMappingsForRole removes all matching rows; findMappingsForRole returns [] afterward", async () => {
        const { roleId } = await rolesRepository.insertRole(db, {
          roleName: `DeleteMappings-${crypto.randomUUID()}`,
          roleDescr: null,
        });
        await rolePermissionAssignRepository.upsertRolePermission(db, {
          roleId,
          permissionId: permissionIdByName.get("users")!,
          permissionType: "READ",
        });
        await rolePermissionAssignRepository.upsertRolePermission(db, {
          roleId,
          permissionId: permissionIdByName.get("roles")!,
          permissionType: "EDIT",
        });

        await rolePermissionAssignRepository.deleteMappingsForRole(db, roleId);

        const result = await rolePermissionAssignRepository.findMappingsForRole(
          db,
          roleId,
        );
        expect(result).toEqual([]);
      });

      it("deleteMappingsForRole on a role with no mappings completes without error (idempotent)", async () => {
        const { roleId } = await rolesRepository.insertRole(db, {
          roleName: `NoMappings-${crypto.randomUUID()}`,
          roleDescr: null,
        });

        await expect(
          rolePermissionAssignRepository.deleteMappingsForRole(db, roleId),
        ).resolves.toBeUndefined();
      });

      it("deleteRoleById removes the role row; subsequent findRoleById returns null", async () => {
        const { roleId } = await rolesRepository.insertRole(db, {
          roleName: `DeleteMe-${crypto.randomUUID()}`,
          roleDescr: null,
        });

        await rolesRepository.deleteRoleById(db, roleId);

        const row = await rolesRepository.findRoleById(db, roleId);
        expect(row).toBeNull();
      });

      it("deleteRoleById raises when role_assign rows still reference the role (FK backstop)", async () => {
        const { roleId } = await rolesRepository.insertRole(db, {
          roleName: `FkBlocked-${crypto.randomUUID()}`,
          roleDescr: null,
        });
        const [user] = await db
          .insert(appuser)
          .values({
            id: crypto.randomUUID(),
            userName: "FK Blocked User",
            userEmail: `${crypto.randomUUID()}@example.com`,
            emailVerified: false,
            authMethod: "LOCAL",
            status: "ACTIVE",
          })
          .returning({ id: appuser.id });
        await db
          .insert(roleAssign)
          .values({ refUserId: user!.id, refRoleId: roleId, assignedBy: null });

        await expect(
          rolesRepository.deleteRoleById(db, roleId),
        ).rejects.toThrow();
      });
    });
  },
);
