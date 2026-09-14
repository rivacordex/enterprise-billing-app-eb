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
//
// NOTE: DATABASE_URL must be a SUPERUSER connection here — beyond the DROP
// SCHEMA / migrate in beforeAll, the customer_bill_line routing test below sets
// `session_replication_role = replica` (a superuser-only GUC) to bypass the FK
// while probing partition routing. The sanctioned runner (.env.test) uses the
// `postgres` superuser; a non-superuser DATABASE_URL will fail that test.
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
      await sql.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
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
      await sql.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
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

    // bm23-spec §Implementation §3 / Verification checklist — the seventh parent.
    it("registers billing.customer_bill_line as a pg_partman parent (monthly, 7-year detach)", async () => {
      if (!sql) throw new Error("sql client not initialized");
      const rows = await sql<
        {
          parent_table: string;
          control: string;
          partition_interval: string;
          retention: string;
          retention_keep_table: boolean;
        }[]
      >`
        SELECT parent_table, control, partition_interval, retention, retention_keep_table
        FROM partman.part_config
        WHERE parent_table = 'billing.customer_bill_line'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.control).toBe("period_partition");
      expect(rows[0]?.partition_interval).toBe("1 mon"); // monthly (pg_partman stores '1 month' canonicalised)
      expect(rows[0]?.retention).toBe("7 years");
      expect(rows[0]?.retention_keep_table).toBe(true); // detach, not drop (architecture §6.9)
    });

    it("routes a future-month customer_bill_line row to its own partition, not the default", async () => {
      if (!sql) throw new Error("sql client not initialized");
      // Pure pg_partman routing check (bm23-spec §Implementation §5 / checklist).
      // Bypass the composite FK to customer_bill via session_replication_role
      // (superuser, txn-scoped) so this asserts partition routing in isolation —
      // the FK + ON DELETE CASCADE is proven end-to-end in
      // tests/db/billrun-db-roles.integration.test.ts. A next-month
      // period_partition is inside pg_partman's premake window, so it must land
      // in a dedicated month partition, never customer_bill_line_default. The
      // probe row is deleted in the same txn so the default-partition assertion
      // below still holds.
      const partition = await sql.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        const [row] = await tx<{ partition: string; id: string }[]>`
          INSERT INTO billing.customer_bill_line
            (ref_customer_bill_id, period_partition, line_no, source,
             ref_product_offering_id, gross_amount, net_amount, grouping_key, currency)
          VALUES ('CBL_ROUTING_PROBE',
                  (date_trunc('month', now()) + interval '1 month')::date,
                  1, 'USAGE', 'POF_ROUTING_PROBE', '10.00', '10.00', 'gk', 'USD')
          RETURNING tableoid::regclass::text AS partition, customer_bill_line_id AS id
        `;
        await tx`
          DELETE FROM billing.customer_bill_line WHERE customer_bill_line_id = ${row!.id}
        `;
        return row!.partition;
      });
      expect(partition).not.toMatch(/customer_bill_line_default$/);
      expect(partition).toMatch(/customer_bill_line_p\d/);
    });

    // bm23 code-review finding #1 — the FK child columns must be indexed or the
    // ON DELETE CASCADE from the whole-account replace (bm28) seq-scans. Assert
    // the two indexes exist on the partitioned parent (0029/0030 precedent).
    it("indexes customer_bill_line on the FK child column and period_partition", async () => {
      if (!sql) throw new Error("sql client not initialized");
      const rows = await sql<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'billing' AND tablename = 'customer_bill_line'
      `;
      const names = rows.map((r) => r.indexname);
      expect(names).toContain("customer_bill_line_ref_customer_bill_id_idx");
      expect(names).toContain("customer_bill_line_period_partition_idx");
    });
  },
);
