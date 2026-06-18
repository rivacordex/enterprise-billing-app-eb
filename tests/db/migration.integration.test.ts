import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

// Reads `DATABASE_URL` directly (not via lib/config): the loader throws at
// import time when the var is absent, which would prevent the loud-skip
// below from ever running. CI provides Postgres as a service and exports
// the var; locally it comes from the developer's shell/.env.
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "migration integration (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;

    beforeAll(async () => {
      sql = postgres(databaseUrl as string, { max: 1 });
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await migrate(drizzle(sql), {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
    });

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    test("the core schema exists and nothing application-related lands in public", async () => {
      const schemas = await sql<{ schema_name: string }[]>`
        SELECT schema_name FROM information_schema.schemata
        WHERE schema_name IN ('core', 'drizzle')
      `;
      expect(schemas.map((r) => r.schema_name).sort()).toEqual([
        "core",
        "drizzle",
      ]);

      const publicTables = await sql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
      `;
      expect(publicTables).toEqual([]);
    });

    test("the four identity tables plus audit_log exist in core", async () => {
      const tables = await sql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'core'
      `;
      expect(tables.map((r) => r.table_name).sort()).toEqual(
        ["account", "appuser", "audit_log", "session", "verification"].sort(),
      );
    });

    test("appuser columns match the spec, including email_verified, excluding image", async () => {
      const columns = await sql<{ column_name: string; is_nullable: string }[]>`
        SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'core' AND table_name = 'appuser'
      `;
      const byName = new Map(columns.map((c) => [c.column_name, c]));
      expect(byName.has("email_verified")).toBe(true);
      expect(byName.get("email_verified")?.is_nullable).toBe("NO");
      expect(byName.has("image")).toBe(false);
      expect(byName.get("user_id")?.is_nullable).toBe("NO");
      expect(byName.get("user_phonenum")?.is_nullable).toBe("YES");
    });

    test("the appuser partial unique index excludes DELETED rows", async () => {
      const indexes = await sql<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'core' AND tablename = 'appuser' AND indexname = 'appuser_email_unique'
      `;
      expect(indexes).toHaveLength(1);
      expect(indexes[0]?.indexdef).toContain("UNIQUE");
      expect(indexes[0]?.indexdef).toContain("WHERE (status <> 'DELETED'");
    });

    test("account and session have FKs to core.appuser with ON DELETE CASCADE; audit_log with ON DELETE SET NULL", async () => {
      const fks = await sql<
        { table_name: string; delete_rule: string; foreign_table: string }[]
      >`
        SELECT
          tc.table_name,
          rc.delete_rule,
          ccu.table_name AS foreign_table
        FROM information_schema.table_constraints tc
        JOIN information_schema.referential_constraints rc
          ON tc.constraint_name = rc.constraint_name AND tc.table_schema = rc.constraint_schema
        JOIN information_schema.constraint_column_usage ccu
          ON rc.unique_constraint_name = ccu.constraint_name
        WHERE tc.table_schema = 'core' AND tc.constraint_type = 'FOREIGN KEY'
      `;
      expect(fks).toHaveLength(3);
      for (const fk of fks) {
        expect(fk.foreign_table).toBe("appuser");
      }

      const byTable = new Map(fks.map((fk) => [fk.table_name, fk.delete_rule]));
      expect(byTable.get("account")).toBe("CASCADE");
      expect(byTable.get("session")).toBe("CASCADE");
      expect(byTable.get("audit_log")).toBe("SET NULL");
    });

    test("session_token is unique", async () => {
      const constraints = await sql<{ constraint_type: string }[]>`
        SELECT tc.constraint_type
        FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
        WHERE tc.table_schema = 'core' AND tc.table_name = 'session'
          AND ccu.column_name = 'session_token' AND tc.constraint_type = 'UNIQUE'
      `;
      expect(constraints).toHaveLength(1);
    });

    test("the three CHECK constraints exist with the expected predicates", async () => {
      const checks = await sql<{ conname: string; def: string }[]>`
        SELECT con.conname, pg_get_constraintdef(con.oid) AS def
        FROM pg_constraint con
        JOIN pg_namespace ns ON con.connamespace = ns.oid
        WHERE ns.nspname = 'core' AND con.contype = 'c'
      `;
      const byName = new Map(checks.map((c) => [c.conname, c.def]));

      expect(byName.get("appuser_auth_method_check")).toContain("SSO");
      expect(byName.get("appuser_auth_method_check")).toContain("LOCAL");

      expect(byName.get("appuser_status_check")).toContain("PENDING");
      expect(byName.get("appuser_status_check")).toContain("DELETED");

      expect(byName.get("account_provider_id_check")).toContain("credential");
      expect(byName.get("account_provider_id_check")).toContain("microsoft");
    });

    test("a second migration run is idempotent", async () => {
      await expect(
        migrate(drizzle(sql), {
          migrationsFolder: "./db/migrations",
          migrationsSchema: "drizzle",
        }),
      ).resolves.not.toThrow();
    });
  },
);
