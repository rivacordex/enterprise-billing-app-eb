import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import { systemConfig } from "@/db/schema/system-config";
import { systemConfigRepository } from "@/db/repositories/system-config.repository";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "systemConfigRepository (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let adminUserId: string;

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

      const [user] = await db
        .insert(appuser)
        .values({
          id: crypto.randomUUID(),
          userName: "Config Admin",
          userEmail: `${crypto.randomUUID()}@example.com`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        })
        .returning({ id: appuser.id });
      adminUserId = user!.id;
    }, 30_000);

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    describe("findAllNonSecret", () => {
      it("returns the seeded app_name row after migration", async () => {
        const rows = await systemConfigRepository.findAllNonSecret(db);
        const seeded = rows.find((r) => r.configKey === "app_name");
        expect(seeded).toBeDefined();
        expect(seeded?.configGroup).toBe("app");
        expect(seeded?.configValue).toBe("Enterprise Billing System");
        expect(seeded?.isSecret).toBe(false);
        expect(seeded?.status).toBe("ACTIVE");
        expect(seeded?.modifiedByName).toBeNull();
      });

      it("excludes is_secret = TRUE rows", async () => {
        await db.insert(systemConfig).values({
          configGroup: "app",
          configKey: "secret_key",
          configValue: "hidden",
          isSecret: true,
        });

        const rows = await systemConfigRepository.findAllNonSecret(db);
        expect(rows.find((r) => r.configKey === "secret_key")).toBeUndefined();
      });

      it("orders rows by config_group ASC then config_key ASC across groups", async () => {
        await db.insert(systemConfig).values([
          { configGroup: "billing", configKey: "currency", configValue: "USD" },
          { configGroup: "app", configKey: "z_last", configValue: "x" },
        ]);

        const rows = await systemConfigRepository.findAllNonSecret(db);
        const pairs = rows.map((r) => `${r.configGroup}:${r.configKey}`);
        const sorted = [...pairs].sort();
        expect(pairs).toEqual(sorted);
      });

      it("modifiedByName is null when modified_by is NULL", async () => {
        const rows = await systemConfigRepository.findAllNonSecret(db);
        const seeded = rows.find((r) => r.configKey === "app_name");
        expect(seeded?.modifiedByName).toBeNull();
        expect(seeded?.modifiedByUserId).toBeNull();
      });

      it("resolves modifiedByName via left join when modified_by is set", async () => {
        await db.insert(systemConfig).values({
          configGroup: "app",
          configKey: "modified_row",
          configValue: "v",
          modifiedBy: adminUserId,
        });

        const rows = await systemConfigRepository.findAllNonSecret(db);
        const modified = rows.find((r) => r.configKey === "modified_row");
        expect(modified?.modifiedByName).toBe("Config Admin");
        expect(modified?.modifiedByUserId).toBe(adminUserId);
      });
    });

    describe("um23: findById", () => {
      it("returns the row for an existing configId, with modifiedByName null when modified_by is NULL", async () => {
        const rows = await systemConfigRepository.findAllNonSecret(db);
        const seeded = rows.find((r) => r.configKey === "app_name");

        const found = await systemConfigRepository.findById(
          db,
          seeded!.configId,
        );
        expect(found?.configKey).toBe("app_name");
        expect(found?.modifiedByName).toBeNull();
      });

      it("resolves modifiedByName via left join when modified_by is set", async () => {
        const [inserted] = await db
          .insert(systemConfig)
          .values({
            configGroup: "app",
            configKey: "findbyid_modified",
            configValue: "v",
            modifiedBy: adminUserId,
          })
          .returning({ configId: systemConfig.configId });

        const found = await systemConfigRepository.findById(
          db,
          inserted!.configId,
        );
        expect(found?.modifiedByName).toBe("Config Admin");
        expect(found?.modifiedByUserId).toBe(adminUserId);
      });

      it("returns null for a non-existent configId", async () => {
        const found = await systemConfigRepository.findById(
          db,
          crypto.randomUUID(),
        );
        expect(found).toBeNull();
      });

      it("returns a secret row without filtering (the service applies the guard)", async () => {
        const [inserted] = await db
          .insert(systemConfig)
          .values({
            configGroup: "app",
            configKey: "findbyid_secret",
            configValue: "hidden",
            isSecret: true,
          })
          .returning({ configId: systemConfig.configId });

        const found = await systemConfigRepository.findById(
          db,
          inserted!.configId,
        );
        expect(found?.isSecret).toBe(true);
      });
    });

    describe("um23: updateValue", () => {
      it("updates config_value, modified_by, and last_modified_datetime", async () => {
        const [inserted] = await db
          .insert(systemConfig)
          .values({
            configGroup: "app",
            configKey: "updatevalue_target",
            configValue: "old",
          })
          .returning({ configId: systemConfig.configId });

        await systemConfigRepository.updateValue(
          db,
          inserted!.configId,
          "new",
          adminUserId,
        );

        const found = await systemConfigRepository.findById(
          db,
          inserted!.configId,
        );
        expect(found?.configValue).toBe("new");
        expect(found?.modifiedByUserId).toBe(adminUserId);
        expect(found?.lastModifiedDatetime.getTime()).toBeGreaterThan(
          Date.now() - 5_000,
        );
      });

      it("sets config_value to null when passed null", async () => {
        const [inserted] = await db
          .insert(systemConfig)
          .values({
            configGroup: "app",
            configKey: "updatevalue_null",
            configValue: "old",
          })
          .returning({ configId: systemConfig.configId });

        await systemConfigRepository.updateValue(
          db,
          inserted!.configId,
          null,
          adminUserId,
        );

        const found = await systemConfigRepository.findById(
          db,
          inserted!.configId,
        );
        expect(found?.configValue).toBeNull();
      });
    });
  },
);
