import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// bm03-spec §Implementation §3/§Verification checklist. Proves
// db/bootstrap/billing-partman-setup.sql registers billing.bill_run_account
// with pg_partman and materializes at least one month partition. Requires
// BOTH DATABASE_URL (app connection, for the prior migration + assertions)
// and BOOTSTRAP_DATABASE_URL (the elevated connection the bootstrap script
// itself needs — audit-partman-setup precedent), so this is skipped by
// default like every other privileged-provisioning step.
const databaseUrl = process.env.DATABASE_URL;
const bootstrapUrl = process.env.BOOTSTRAP_DATABASE_URL;

function readStatements(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe.skipIf(!databaseUrl || !bootstrapUrl)(
  "billing pg_partman bootstrap (bm03-spec §3, requires DATABASE_URL + BOOTSTRAP_DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql | undefined;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      // The bootstrap connection also runs DROP/CREATE — guard it too so it
      // can never point at a non-test database.
      assertTestDatabaseUrl(bootstrapUrl as string);
      sql = postgres(databaseUrl as string, { max: 5 });
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "partman" CASCADE');
      const db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      const bootstrapSql = postgres(bootstrapUrl as string, { max: 1 });
      try {
        for (const statement of readStatements(
          "./db/bootstrap/audit-partman-setup.sql",
        )) {
          await bootstrapSql.unsafe(statement);
        }
        for (const statement of readStatements(
          "./db/bootstrap/billing-partman-setup.sql",
        )) {
          await bootstrapSql.unsafe(statement);
        }
      } finally {
        await bootstrapSql.end();
      }
    }, 60_000);

    afterAll(async () => {
      if (!sql) return;
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "partman" CASCADE');
      await sql.end();
    });

    it("registers billing.bill_run_account as a pg_partman parent", async () => {
      if (!sql) throw new Error("sql client not initialized");
      const rows = await sql`
        SELECT parent_table, control, partition_interval, retention, retention_keep_table
        FROM partman.part_config
        WHERE parent_table = 'billing.bill_run_account'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.control).toBe("period_partition");
      expect(rows[0]?.retention_keep_table).toBe(true); // detach, not drop (architecture §6.9)
    });

    it("materializes at least one month partition", async () => {
      if (!sql) throw new Error("sql client not initialized");
      const rows = await sql`
        SELECT inhrelid::regclass::text AS child
        FROM pg_inherits
        WHERE inhparent = 'billing.bill_run_account'::regclass
      `;
      // The default partition plus at least one premade month partition.
      expect(rows.length).toBeGreaterThan(1);
    });
  },
);
