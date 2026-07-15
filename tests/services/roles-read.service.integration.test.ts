import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { roles } from "@/db/schema/roles";
import { permissions } from "@/db/schema/permissions";
import { rolePermissionAssign } from "@/db/schema/role-permission-assign";
import type {
  getAllRolesWithMappings as GetAllRolesWithMappings,
  getRoleWithMappings as GetRoleWithMappings,
} from "@/services/roles/roles-read.service";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

const databaseUrl = process.env.DATABASE_URL;

// Exercises the real `getAllRolesWithMappings`/`getRoleWithMappings`
// services (their own internal `@/db/client` pool, not the local `db`
// connection below) against a live Postgres database — imported dynamically
// inside `beforeAll`, after confirming `DATABASE_URL` is set, mirroring
// tests/services/users-write.service.integration.test.ts.
describe.skipIf(!databaseUrl)(
  "roles-read.service (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let getAllRolesWithMappings: typeof GetAllRolesWithMappings;
    let getRoleWithMappings: typeof GetRoleWithMappings;
    let adminRoleId: string;

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

      ({ getAllRolesWithMappings, getRoleWithMappings } =
        await import("@/services/roles/roles-read.service"));

      const insertedRoles = await db
        .insert(roles)
        .values([
          { roleName: "USER", roleDescr: null },
          { roleName: "ADMIN", roleDescr: "Full access" },
          { roleName: "MANAGER", roleDescr: null },
        ])
        .returning({ roleId: roles.roleId, roleName: roles.roleName });

      adminRoleId = insertedRoles.find((r) => r.roleName === "ADMIN")!.roleId;

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

    describe("getAllRolesWithMappings", () => {
      it("returns exactly 3 roles", async () => {
        const result = await getAllRolesWithMappings();
        expect(result).toHaveLength(3);
      });

      it("ADMIN's mappings are users:DELETE, roles:DELETE, system_config:DELETE, audit_log:READ, products:null", async () => {
        const result = await getAllRolesWithMappings();
        const admin = result.find((r) => r.roleName === "ADMIN")!;
        expect(admin.mappings).toEqual([
          { permissionName: "users", assignedLevel: "DELETE" },
          { permissionName: "roles", assignedLevel: "DELETE" },
          { permissionName: "system_config", assignedLevel: "DELETE" },
          { permissionName: "audit_log", assignedLevel: "READ" },
          { permissionName: "products", assignedLevel: null },
          { permissionName: "customers", assignedLevel: null },
        ]);
      });

      it("MANAGER and USER mappings are all null", async () => {
        const result = await getAllRolesWithMappings();
        for (const roleName of ["MANAGER", "USER"]) {
          const role = result.find((r) => r.roleName === roleName)!;
          expect(role.mappings.every((m) => m.assignedLevel === null)).toBe(
            true,
          );
        }
      });

      it("mappings order is always users, roles, system_config, audit_log, products, customers regardless of DB row order", async () => {
        const result = await getAllRolesWithMappings();
        for (const role of result) {
          expect(role.mappings.map((m) => m.permissionName)).toEqual([
            "users",
            "roles",
            "system_config",
            "audit_log",
            "products",
            "customers",
          ]);
        }
      });
    });

    describe("getRoleWithMappings", () => {
      it("returns the ADMIN role with the same mapping as getAllRolesWithMappings", async () => {
        const result = await getRoleWithMappings(adminRoleId);
        expect(result?.roleName).toBe("ADMIN");
        expect(result?.mappings).toEqual([
          { permissionName: "users", assignedLevel: "DELETE" },
          { permissionName: "roles", assignedLevel: "DELETE" },
          { permissionName: "system_config", assignedLevel: "DELETE" },
          { permissionName: "audit_log", assignedLevel: "READ" },
          { permissionName: "products", assignedLevel: null },
          { permissionName: "customers", assignedLevel: null },
        ]);
      });

      it("returns null for a non-existent role id", async () => {
        const result = await getRoleWithMappings(
          "00000000-0000-0000-0000-000000000000",
        );
        expect(result).toBeNull();
      });
    });
  },
);
