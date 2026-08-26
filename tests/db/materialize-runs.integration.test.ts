import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { billCycle } from "@/db/schema/billing/catalogs";
import { billRun } from "@/db/schema/billing/bill-run";
import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// bm02-spec §8 / overview success criterion 1 — the core materialization
// guarantee under CONCURRENT loads: two simultaneous inserts of the same
// cycle-period produce EXACTLY ONE `bill_run` row (the `(ref_bill_cycle_id,
// period_start)` UNIQUE + ON CONFLICT DO NOTHING), and only one of the two
// calls reports the row as inserted (so a no-op load audits nothing).
const databaseUrl = process.env.DATABASE_URL;
const RACE_RUNS = 4;

describe.skipIf(!databaseUrl)(
  "materialize idempotency (bm02-spec §8, requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql | undefined;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let cycleId: string;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 5 });
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      const [cycle] = await db
        .insert(billCycle)
        .values({ name: "BM02VERIFY Cycle", lastEditedBy: null })
        .returning({ billCycleId: billCycle.billCycleId });
      cycleId = cycle!.billCycleId;
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
      await sql.end();
    });

    it("two concurrent inserts of the same period create exactly one row", async () => {
      for (let i = 0; i < RACE_RUNS; i++) {
        // A distinct period per race iteration so each starts clean.
        const month = String(i + 1).padStart(2, "0");
        const rows = [
          {
            refBillCycleId: cycleId,
            periodStart: `2026-${month}-01`,
            periodEnd: `2026-${month}-28`,
            scheduledRunDate: `2026-${month}-29`,
          },
        ];

        const [a, b] = await Promise.all([
          billRunRepository.insertMissingRuns(db, rows),
          billRunRepository.insertMissingRuns(db, rows),
        ]);

        // Exactly one of the two calls reports the row as inserted.
        expect(a.length + b.length).toBe(1);

        const [row] = await db
          .select({ total: count() })
          .from(billRun)
          .where(eq(billRun.periodStart, `2026-${month}-01`));
        expect(row?.total).toBe(1);
      }
    });

    it("re-inserting an existing period is a no-op (returns nothing)", async () => {
      const rows = [
        {
          refBillCycleId: cycleId,
          periodStart: "2026-01-01",
          periodEnd: "2026-01-28",
          scheduledRunDate: "2026-01-29",
        },
      ];
      const inserted = await billRunRepository.insertMissingRuns(db, rows);
      expect(inserted).toHaveLength(0); // already materialized by the race test
    });
  },
);
