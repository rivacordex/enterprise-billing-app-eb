import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// rm01-spec §Verification checklist. Named `rm01-schema.test.ts` in the spec's
// file-organization section; suffixed `.integration.test.ts` here (like every
// other live-DB suite in this repo) so it is actually picked up by
// vitest.integration.config.ts's include glob rather than the DB-free default
// project. Every item below asserts against a live database — the constraint
// is the deliverable (rm01-spec D1), not the tables.
const databaseUrl = process.env.DATABASE_URL;
const bootstrapUrl = process.env.BOOTSTRAP_DATABASE_URL;

function readStatements(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

type Row = Record<string, unknown>;

function baseUdrRatedRow(overrides: Row = {}): Row {
  const startDatetime = overrides.start_datetime ?? "2026-08-14T10:00:00Z";
  return {
    partition_period: "2026-08-01",
    udr_type: "RAN_USAGE",
    start_datetime: startDatetime,
    end_datetime: "2026-08-14T10:05:00Z",
    udr_subscriber_ref_id: "SUB-0001",
    udr_key: "KEY-DEFAULT",
    udr_usage_quantity: "100.000000",
    udr_usage_unit: "MB",
    udr_rate_type: "FLAT",
    udr_rated_price: "1.00",
    udr_rated_price_raw: "1.000000",
    udr_rounding_mode: "HALF_UP",
    udr_currency: "MYR",
    udr_ref_batch_id: "UDRBAT00000001",
    udr_source_file: "RAN_USAGE_20260814.dat",
    rating_engine_version: "v1.0.0",
    rating_flow_revision: 1,
    ...overrides,
  };
}

function baseProcessLogRow(overrides: Row = {}): Row {
  const logDatetime = overrides.log_datetime ?? "2026-08-14T10:00:00Z";
  return {
    partition_period: "2026-08-01",
    log_datetime: logDatetime,
    component: "PRP",
    log_level: "INFO",
    event_code: "TEST_EVENT",
    ...overrides,
  };
}

function baseUdrBatchRow(overrides: Row = {}): Row {
  return {
    file_key: "FILEKEY-DEFAULT",
    source_file: "RAN_USAGE_20260814.dat",
    file_key_rule: "RAN_USAGE_DATE_PREFIX",
    udr_type: "RAN_USAGE",
    ...overrides,
  };
}

describe.skipIf(!databaseUrl)(
  "rating schema foundation (rm01-spec, requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;

    const dropAll = async (client: postgresjs.Sql) => {
      await client.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "partman" CASCADE');
    };

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      // max: 1 — the time-zone tests (10, 12) issue `SET TIME ZONE` and then
      // rely on the following INSERT running under that same session. With a
      // multi-connection pool those could land on different physical
      // connections, so the tz would neither take effect for the insert nor be
      // reset afterwards, leaking session state across tests. A single
      // connection makes session state deterministic; the suite runs its
      // queries sequentially, so it costs no real concurrency.
      sql = postgres(databaseUrl as string, { max: 1 });
      await dropAll(sql);
      const db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      // Provision pg_partman BEFORE any row-inserting test runs, so live rows
      // route to their month partitions instead of the bootstrap *_default
      // partitions (which test 23 requires to stay empty). Gated on
      // BOOTSTRAP_DATABASE_URL: without it the partman tests are skipped and
      // inserts harmlessly fall through to the default partition.
      if (bootstrapUrl) {
        assertTestDatabaseUrl(bootstrapUrl);
        const bootstrapSql = postgres(bootstrapUrl, { max: 1 });
        try {
          for (const statement of readStatements(
            "./db/bootstrap/audit-partman-setup.sql",
          )) {
            await bootstrapSql.unsafe(statement);
          }
          for (const statement of readStatements(
            "./db/bootstrap/rating-partman-setup.sql",
          )) {
            await bootstrapSql.unsafe(statement);
          }
        } finally {
          await bootstrapSql.end();
        }
      }
    }, 60_000);

    afterAll(async () => {
      if (!sql) return;
      await dropAll(sql);
      await sql.end();
    });

    async function insertUdrRated(overrides: Row = {}) {
      const row = baseUdrRatedRow(overrides);
      return sql`INSERT INTO rating.udr_rated ${sql(row)} RETURNING udr_id, is_live, status`;
    }

    async function insertProcessLog(overrides: Row = {}) {
      const row = baseProcessLogRow(overrides);
      return sql`INSERT INTO rating.process_log ${sql(row)} RETURNING log_id`;
    }

    async function insertUdrBatch(overrides: Row = {}) {
      const row = baseUdrBatchRow(overrides);
      return sql`INSERT INTO rating.udr_batch ${sql(row)} RETURNING batch_id`;
    }

    describe("the live-row uniqueness guarantee (Inv #3)", () => {
      it("1. inserting a second live row for the same natural key raises a unique violation", async () => {
        const key = "NK-001";
        await insertUdrRated({ udr_key: key });
        await expect(insertUdrRated({ udr_key: key })).rejects.toThrow();
      });

      it("2. four consecutive supersede-then-insert cycles leave exactly one live row and four SUPERSEDED rows", async () => {
        const key = "NK-002";
        await insertUdrRated({ udr_key: key });
        for (let i = 0; i < 4; i++) {
          await sql`UPDATE rating.udr_rated SET status = 'SUPERSEDED' WHERE udr_key = ${key} AND is_live`;
          await insertUdrRated({ udr_key: key });
        }
        const rows = await sql<
          { status: string }[]
        >`SELECT status FROM rating.udr_rated WHERE udr_key = ${key}`;
        expect(rows.filter((r) => r.status === "SUPERSEDED")).toHaveLength(4);
        expect(rows.filter((r) => r.status === "RATED")).toHaveLength(1);
      });

      it("3. setting the only live row to SUPERSEDED leaves zero live rows without error", async () => {
        const key = "NK-003";
        await insertUdrRated({ udr_key: key });
        await expect(
          sql`UPDATE rating.udr_rated SET status = 'SUPERSEDED' WHERE udr_key = ${key}`,
        ).resolves.toBeDefined();
        const rows = await sql<
          { is_live: boolean | null }[]
        >`SELECT is_live FROM rating.udr_rated WHERE udr_key = ${key}`;
        expect(rows.every((r) => r.is_live === null)).toBe(true);
      });

      it("4. updating status recomputes is_live with no direct write to is_live; a direct write is rejected", async () => {
        const key = "NK-004";
        const [inserted] = await insertUdrRated({ udr_key: key });
        expect(inserted?.is_live).toBe(true);
        await sql`UPDATE rating.udr_rated SET status = 'SUPERSEDED' WHERE udr_key = ${key}`;
        const [after] = await sql<
          { is_live: boolean | null }[]
        >`SELECT is_live FROM rating.udr_rated WHERE udr_key = ${key}`;
        expect(after?.is_live).toBeNull();
        await expect(
          sql`UPDATE rating.udr_rated SET is_live = true WHERE udr_key = ${key}`,
        ).rejects.toThrow();
      });

      it("5. a REJECTED row and a RATED row for the same natural key coexist", async () => {
        const key = "NK-005";
        await insertUdrRated({ udr_key: key, status: "REJECTED" });
        await insertUdrRated({ udr_key: key, status: "RATED" });
        const rows =
          await sql`SELECT status FROM rating.udr_rated WHERE udr_key = ${key}`;
        expect(rows).toHaveLength(2);
      });
    });

    describe("key length", () => {
      it("6. a udr_key of 512 ASCII characters inserts", async () => {
        const key = "A".repeat(512);
        await expect(insertUdrRated({ udr_key: key })).resolves.toBeDefined();
      });

      it("7. a udr_key of 512 four-byte UTF-8 characters (2048 bytes) inserts", async () => {
        const key = "\u{1F600}".repeat(512);
        await expect(insertUdrRated({ udr_key: key })).resolves.toBeDefined();
      });

      it("8. 513 characters is rejected by udr_rated_udr_key_length_check, not a btree index-row error", async () => {
        const key = "A".repeat(513);
        await expect(insertUdrRated({ udr_key: key })).rejects.toThrow(
          /udr_rated_udr_key_length_check/,
        );
      });
    });

    describe("partition correctness (Inv #15)", () => {
      it("9. a row whose partition_period disagrees with rating.period_of(start_datetime) is rejected", async () => {
        await expect(
          insertUdrRated({
            udr_key: "NK-009",
            partition_period: "2026-07-01",
          }),
        ).rejects.toThrow(/udr_rated_period_matches_check/);
      });

      it("10. the identical row inserts successfully under UTC, Asia/Singapore and America/New_York sessions", async () => {
        for (const tz of ["UTC", "Asia/Singapore", "America/New_York"]) {
          await sql.unsafe(`SET TIME ZONE '${tz}'`);
          await expect(
            insertUdrRated({ udr_key: `NK-010-${tz}` }),
          ).resolves.toBeDefined();
        }
        await sql.unsafe("SET TIME ZONE 'UTC'");
      });

      it("11. rating.period_of('2026-09-01 02:00+08') returns the UTC month, 2026-08-01", async () => {
        const [row] = await sql<
          { period: string }[]
        >`SELECT rating.period_of('2026-09-01 02:00+08'::timestamptz) AS period`;
        expect(row?.period).toBe("2026-08-01");
      });

      it("12. the same three assertions hold for process_log.partition_period against log_datetime", async () => {
        await expect(
          insertProcessLog({ partition_period: "2026-07-01" }),
        ).rejects.toThrow(/process_log_period_matches_check/);

        for (const tz of ["UTC", "Asia/Singapore", "America/New_York"]) {
          await sql.unsafe(`SET TIME ZONE '${tz}'`);
          await expect(
            insertProcessLog({ event_code: `TZ-${tz}` }),
          ).resolves.toBeDefined();
        }
        await sql.unsafe("SET TIME ZONE 'UTC'");

        const [row] = await sql<
          { period: string }[]
        >`SELECT rating.period_of('2026-09-01 02:00+08'::timestamptz) AS period`;
        expect(row?.period).toBe("2026-08-01");
      });
    });

    describe("structural invariants", () => {
      it("13. no foreign key exists between rating and any other schema, in either direction", async () => {
        const rows = await sql`
          SELECT c.conname
          FROM pg_constraint c
          JOIN pg_class conrel ON conrel.oid = c.conrelid
          JOIN pg_namespace connsp ON connsp.oid = conrel.relnamespace
          LEFT JOIN pg_class confrel ON confrel.oid = c.confrelid
          LEFT JOIN pg_namespace confnsp ON confnsp.oid = confrel.relnamespace
          WHERE c.contype = 'f'
            AND (connsp.nspname = 'rating' OR confnsp.nspname = 'rating')
        `;
        expect(rows).toHaveLength(0);
      });

      it("14. process_log has no FK on event_code; an unrecognised code inserts successfully", async () => {
        await expect(
          insertProcessLog({ event_code: "TOTALLY_UNKNOWN_CODE" }),
        ).resolves.toBeDefined();
      });

      it("15. udr_rated has no batch-run/supersede lineage columns; udr_batch has them", async () => {
        const udrRatedCols = await sql<{ column_name: string }[]>`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'rating' AND table_name = 'udr_rated'
        `;
        const ratedNames = udrRatedCols.map((r) => r.column_name);
        expect(ratedNames).not.toContain("udr_batch_run_num");
        expect(ratedNames).not.toContain("supersede_reason");
        expect(ratedNames).not.toContain("superseded_by_udr_id");

        const udrBatchCols = await sql<{ column_name: string }[]>`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'rating' AND table_name = 'udr_batch'
        `;
        const batchNames = udrBatchCols.map((r) => r.column_name);
        expect(batchNames).toContain("batch_run_num");
        expect(batchNames).toContain("supersede_reason");
        expect(batchNames).toContain("superseded_by_batch_id");
      });

      it("15a. batch_run_num appears in exactly one unique constraint and in no index on udr_rated", async () => {
        const uniques = await sql<{ conname: string }[]>`
          SELECT DISTINCT c.conname
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
          WHERE c.contype = 'u' AND n.nspname = 'rating' AND a.attname = 'batch_run_num'
        `;
        expect(uniques.map((r) => r.conname)).toEqual([
          "udr_batch_file_key_run_uq",
        ]);

        const indexesOnRated = await sql<{ indexname: string }[]>`
          SELECT indexname FROM pg_indexes
          WHERE schemaname = 'rating' AND tablename LIKE 'udr_rated%'
            AND indexdef LIKE '%batch_run_num%'
        `;
        expect(indexesOnRated).toHaveLength(0);
      });

      it("16. money columns have the specified precision and scale", async () => {
        const rows = await sql<
          {
            column_name: string;
            numeric_precision: number;
            numeric_scale: number;
          }[]
        >`
          SELECT column_name, numeric_precision, numeric_scale
          FROM information_schema.columns
          WHERE table_schema = 'rating' AND table_name = 'udr_rated'
            AND column_name IN (
              'udr_rated_price', 'udr_rated_price_raw', 'udr_usage_rate',
              'udr_usage_quantity', 'udr_discount_amount',
              'udr_discount_amount_raw', 'udr_discount_rate'
            )
        `;
        const byName = Object.fromEntries(
          rows.map((r) => [
            r.column_name,
            { p: r.numeric_precision, s: r.numeric_scale },
          ]),
        );
        expect(byName.udr_rated_price).toEqual({ p: 18, s: 2 });
        expect(byName.udr_rated_price_raw).toEqual({ p: 18, s: 6 });
        expect(byName.udr_usage_rate).toEqual({ p: 18, s: 6 });
        expect(byName.udr_usage_quantity).toEqual({ p: 20, s: 6 });
        expect(byName.udr_discount_amount).toEqual({ p: 18, s: 2 });
        expect(byName.udr_discount_amount_raw).toEqual({ p: 18, s: 6 });
        expect(byName.udr_discount_rate).toEqual({ p: 18, s: 6 });
      });

      it("17. start_datetime/end_datetime have no precision modifier; operational timestamps have precision 3", async () => {
        const rows = await sql<
          { column_name: string; datetime_precision: number }[]
        >`
          SELECT column_name, datetime_precision
          FROM information_schema.columns
          WHERE table_schema = 'rating' AND table_name = 'udr_rated'
            AND column_name IN (
              'start_datetime', 'end_datetime', 'rated_datetime',
              'insert_datetime', 'upsert_datetime'
            )
        `;
        const byName = Object.fromEntries(
          rows.map((r) => [r.column_name, r.datetime_precision]),
        );
        expect(byName.start_datetime).toBe(6);
        expect(byName.end_datetime).toBe(6);
        expect(byName.rated_datetime).toBe(3);
        expect(byName.insert_datetime).toBe(3);
        expect(byName.upsert_datetime).toBe(3);
      });
    });

    describe("the file claim (Inv #7)", () => {
      it("18. two inserts with the same (file_key, batch_run_num) — the second raises a unique violation", async () => {
        const fileKey = "FILEKEY-018";
        await insertUdrBatch({ file_key: fileKey, batch_run_num: 1 });
        await expect(
          insertUdrBatch({ file_key: fileKey, batch_run_num: 1 }),
        ).rejects.toThrow();
      });

      it("19. the same file_key with batch_run_num = 2 inserts successfully", async () => {
        const fileKey = "FILEKEY-019";
        await insertUdrBatch({ file_key: fileKey, batch_run_num: 1 });
        await expect(
          insertUdrBatch({ file_key: fileKey, batch_run_num: 2 }),
        ).resolves.toBeDefined();
      });

      it("19a. two differently named files that derive the same file_key collide on run 1", async () => {
        const fileKey = "FILEKEY-019A";
        await insertUdrBatch({
          file_key: fileKey,
          source_file: "RAN_USAGE_20260814.dat",
          batch_run_num: 1,
        });
        await expect(
          insertUdrBatch({
            file_key: fileKey,
            source_file: "RAN_USAGE_20260814_v2.dat",
            batch_run_num: 1,
          }),
        ).rejects.toThrow();
      });

      it("19b. udr_batch.file_key is NOT NULL and no unique constraint references source_file", async () => {
        const [col] = await sql<{ is_nullable: string }[]>`
          SELECT is_nullable FROM information_schema.columns
          WHERE table_schema = 'rating' AND table_name = 'udr_batch' AND column_name = 'file_key'
        `;
        expect(col?.is_nullable).toBe("NO");

        const uniqueOnSourceFile = await sql`
          SELECT c.conname
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
          WHERE c.contype = 'u' AND n.nspname = 'rating' AND t.relname = 'udr_batch'
            AND a.attname = 'source_file'
        `;
        expect(uniqueOnSourceFile).toHaveLength(0);
      });
    });

    describe.skipIf(!bootstrapUrl)(
      "partitioning and maintenance (requires BOOTSTRAP_DATABASE_URL)",
      () => {
        // The pg_partman bootstrap runs in the outer beforeAll (before any
        // inserting test) so live rows never touch the *_default partitions.

        it("20. partman.part_config holds both parents with the specified premake/retention", async () => {
          const rows = await sql<
            {
              parent_table: string;
              premake: number;
              infinite_time_partitions: boolean;
              retention: string;
              retention_keep_table: boolean;
            }[]
          >`
            SELECT parent_table, premake, infinite_time_partitions, retention, retention_keep_table
            FROM partman.part_config
            WHERE parent_table IN ('rating.udr_rated', 'rating.process_log')
          `;
          expect(rows).toHaveLength(2);
          const byTable = Object.fromEntries(
            rows.map((r) => [r.parent_table, r]),
          );
          expect(byTable["rating.udr_rated"]?.premake).toBe(4);
          expect(byTable["rating.udr_rated"]?.infinite_time_partitions).toBe(
            true,
          );
          expect(byTable["rating.udr_rated"]?.retention).toBe("7 years");
          expect(byTable["rating.udr_rated"]?.retention_keep_table).toBe(true);
          expect(byTable["rating.process_log"]?.retention).toBe("24 months");
          expect(byTable["rating.process_log"]?.retention_keep_table).toBe(
            true,
          );
        });

        it("21. running partman.run_maintenance_proc() creates forward partitions for both tables", async () => {
          await sql`CALL partman.run_maintenance_proc()`;
          const udrRatedParts = await sql`
            SELECT inhrelid::regclass::text AS child FROM pg_inherits
            WHERE inhparent = 'rating.udr_rated'::regclass
          `;
          const logParts = await sql`
            SELECT inhrelid::regclass::text AS child FROM pg_inherits
            WHERE inhparent = 'rating.process_log'::regclass
          `;
          // The default partition plus at least one premade month partition.
          expect(udrRatedParts.length).toBeGreaterThan(1);
          expect(logParts.length).toBeGreaterThan(1);
        });

        it("22. no new cron.schedule_in_database entry was added", async () => {
          const rows = await sql<
            { jobname: string }[]
          >`SELECT jobname FROM cron.job`;
          expect(rows.map((r) => r.jobname)).toEqual([
            "audit-log-partman-maintenance",
          ]);
        });

        it("23. both *_default partitions exist and contain zero rows", async () => {
          const [udrDefault] = await sql<{ n: number }[]>`
            SELECT count(*)::int AS n FROM rating.udr_rated_default
          `;
          const [logDefault] = await sql<{ n: number }[]>`
            SELECT count(*)::int AS n FROM rating.process_log_default
          `;
          expect(udrDefault?.n).toBe(0);
          expect(logDefault?.n).toBe(0);
        });

        it("24. the shipped preflight guard raises when pg_partman is below v5", async () => {
          // Exercise the guard that actually ships in rating-partman-setup.sql
          // rather than a hand-copied duplicate that could silently drift.
          const preflight = readStatements(
            "./db/bootstrap/rating-partman-setup.sql",
          ).find((s) => s.includes("split_part(v, '.', 1)::int < 5"));
          expect(preflight).toBeDefined();

          // Swap only the version source (live pg_extension → a simulated
          // sub-v5 literal); the comparison logic under test stays exactly what
          // ships. If the SELECT wording drifts the replace won't match and the
          // block queries the real v5+ extension without raising, failing this
          // assertion loudly.
          const simulated = (preflight as string).replace(
            /SELECT extversion INTO v FROM pg_extension WHERE extname = 'pg_partman';/,
            "v := '4.7.1';",
          );
          await expect(sql.unsafe(simulated)).rejects.toThrow(/pg_partman/);
        });
      },
    );

    describe("build hygiene", () => {
      it("28. no core.permissions row was added for this module (no pages, no UI)", async () => {
        const rows = await sql<{ permission_name: string }[]>`
          SELECT permission_name FROM core.permissions
          WHERE permission_name ILIKE '%rating%' OR permission_name ILIKE '%udr%'
        `;
        expect(rows).toHaveLength(0);
      });
    });
  },
);
