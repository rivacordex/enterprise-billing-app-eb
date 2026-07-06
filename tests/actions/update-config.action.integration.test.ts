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
import { systemConfig } from "@/db/schema/system-config";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import type { updateConfigAction as UpdateConfigAction } from "@/actions/system-config/update-config.action";

// Exercises the real `updateConfigAction` (guard + validation + service +
// revalidatePath) against a live Postgres database, mirroring
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
  "updateConfigAction (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let updateConfigAction: typeof UpdateConfigAction;

    let adminUserId: string;
    let noGrantsUserId: string;
    let testConfigId: string;

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

      ({ updateConfigAction } =
        await import("@/actions/system-config/update-config.action"));

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

      const [systemConfigPermission] = await db
        .insert(permissions)
        .values({
          permissionName: "system_config",
          permissionInfo: "System Config",
        })
        .returning({ permissionId: permissions.permissionId });

      await db.insert(rolePermissionAssign).values({
        refRoleId: adminRole!.roleId,
        refPermissionId: systemConfigPermission!.permissionId,
        permissionType: "EDIT",
      });

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

    beforeEach(async () => {
      getSessionMock.mockReset();
      const [testRow] = await db
        .insert(systemConfig)
        .values({
          configGroup: "app",
          configKey: `test_key_${randomUUID()}`,
          configValue: "original-value",
        })
        .returning({ configId: systemConfig.configId });
      testConfigId = testRow!.configId;
    });

    it("admin_user updates the value and writes a SYSTEM_CONFIG_CHANGED audit row", async () => {
      mockSession(adminUserId);

      const result = await updateConfigAction({
        configId: testConfigId,
        configValue: "updated-value",
      });

      expect(result).toEqual({ ok: true });

      const [configRow] = await db
        .select()
        .from(systemConfig)
        .where(eq(systemConfig.configId, testConfigId));
      expect(configRow?.configValue).toBe("updated-value");
      expect(configRow?.modifiedBy).toBe(adminUserId);

      const [auditRow] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, testConfigId));
      expect(auditRow?.eventType).toBe("SYSTEM_CONFIG_CHANGED");
      expect(auditRow?.actorUserId).toBe(adminUserId);
      expect(
        (auditRow?.beforeData as { configValue: string | null } | null)
          ?.configValue,
      ).toBe("original-value");
      expect(
        (auditRow?.afterData as { configValue: string | null } | null)
          ?.configValue,
      ).toBe("updated-value");
    });

    it("returns NOT_FOUND for a non-existent configId", async () => {
      mockSession(adminUserId);

      const result = await updateConfigAction({
        configId: randomUUID(),
        configValue: "x",
      });

      expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
    });

    it("returns SECRET_ROW for a row marked secret and leaves it unchanged", async () => {
      mockSession(adminUserId);

      const [secretRow] = await db
        .insert(systemConfig)
        .values({
          configGroup: "app",
          configKey: `secret_key_${randomUUID()}`,
          configValue: "hidden",
          isSecret: true,
        })
        .returning({ configId: systemConfig.configId });

      const result = await updateConfigAction({
        configId: secretRow!.configId,
        configValue: "should-not-write",
      });

      expect(result).toEqual({ ok: false, code: "SECRET_ROW" });

      const [configRow] = await db
        .select()
        .from(systemConfig)
        .where(eq(systemConfig.configId, secretRow!.configId));
      expect(configRow?.configValue).toBe("hidden");
    });

    it("no_grants_user is forbidden and the value is not changed", async () => {
      mockSession(noGrantsUserId);

      const result = await updateConfigAction({
        configId: testConfigId,
        configValue: "should-not-write",
      });

      expect(result).toEqual({ ok: false, code: "FORBIDDEN" });

      const [configRow] = await db
        .select()
        .from(systemConfig)
        .where(eq(systemConfig.configId, testConfigId));
      expect(configRow?.configValue).toBe("original-value");
    });

    it("redirects to /login when there is no session (FORBIDDEN at the action boundary)", async () => {
      mockSession(null);

      const result = await updateConfigAction({
        configId: testConfigId,
        configValue: "should-not-write",
      });

      expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    });
  },
);
