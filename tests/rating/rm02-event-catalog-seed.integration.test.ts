import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql as dsql } from "drizzle-orm";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { eventCatalog } from "@/db/schema/rating/event-catalog";
import type { Database } from "@/db/client";
import {
  EVENT_CATALOG_SEED,
  RATING_EVENT_CODES,
  seedEventCatalog,
} from "@/db/seeds/rating-event-catalog.data";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// rm02-spec §Verification checklist. Every item below asserts against a live
// database — the seeded catalog is the deliverable, the resolver behaviour its
// contract. Named `.integration.test.ts` so vitest.integration.config.ts's
// include glob picks it up (rm01 precedent). event_catalog is not partitioned
// and process_log falls through to its bootstrap default partition, so this
// suite needs DATABASE_URL only — no pg_partman bootstrap.
const databaseUrl = process.env.DATABASE_URL;

const ALLOWED_SEVERITIES = [
  "CRITICAL",
  "MAJOR",
  "MINOR",
  "WARNING",
  "INDETERMINATE",
  "CLEARED",
];

// The listed codes that require a human and must never auto-clear (rm02-spec
// §Verification 10).
const NON_AUTO_CLEARING = [
  "RECON_IMBALANCE",
  "SHRINKING_REISSUE",
  "LOAD_BLOCKED_BILLED",
  "FILE_KEY_UNRESOLVED",
  "CURRENCY_MISMATCH",
  "DUPLICATE_BATCH",
  "CROSS_PERIOD_SUPERSEDE",
];

type CatalogRow = {
  event_code: string;
  component: string | null;
  default_severity: string | null;
  event_type: string | null;
  probable_cause: string | null;
  description: string | null;
  is_auto_clearing: boolean;
  clear_event_code: string | null;
  is_active: boolean;
};

describe.skipIf(!databaseUrl)(
  "event_catalog seed (rm02-spec, requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: Database;

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
      sql = postgres(databaseUrl as string, { max: 1 });
      await dropAll(sql);
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
      // Item 22: the seed runs green from an empty database after rm01's
      // migration, via the same reusable upsert the runner script calls.
      await seedEventCatalog(db);
    }, 60_000);

    afterAll(async () => {
      if (!sql) return;
      await dropAll(sql);
      await sql.end();
    });

    const allRows = () =>
      sql<CatalogRow[]>`SELECT * FROM rating.event_catalog ORDER BY event_code`;

    // rm02-spec §A1: the resolver keys off ROW PRESENCE (and is_active), never
    // severity nullity. This is the exact query the spec prescribes; a
    // COALESCE(default_severity,'INDETERMINATE') implementation would fail
    // items 13/14.
    async function resolve(code: string): Promise<{
      perceived_severity: string | null;
      event_type: string | null;
      probable_cause: string | null;
    }> {
      const [row] = await sql<
        {
          perceived_severity: string | null;
          event_type: string | null;
          probable_cause: string | null;
        }[]
      >`
        SELECT CASE WHEN c.event_code IS NULL THEN 'INDETERMINATE'
                    ELSE c.default_severity END AS perceived_severity,
               c.event_type, c.probable_cause
        FROM (SELECT ${code}::text AS event_code) e
        LEFT JOIN rating.event_catalog c
          ON c.event_code = e.event_code AND c.is_active
      `;
      return row!;
    }

    // Resolve a code then write the process_log row it produces (rm02-spec
    // §Verification 13/14: the row is still written with its log_level even when
    // severity is NULL or the code is uncatalogued — proving the missing FK is
    // deliberate). Returns the written perceived_severity.
    async function writeResolvedLog(
      code: string,
      batchId: string,
    ): Promise<string | null> {
      const resolved = await resolve(code);
      await sql`
        INSERT INTO rating.process_log ${sql({
          partition_period: "2026-08-01",
          log_datetime: "2026-08-14T10:00:00Z",
          component: "RL",
          log_level: "INFO",
          perceived_severity: resolved.perceived_severity,
          event_code: code,
          event_type: resolved.event_type,
          probable_cause: resolved.probable_cause,
          batch_id: batchId,
        })}
      `;
      return resolved.perceived_severity;
    }

    describe("schema amendment (§A)", () => {
      it("1. default_severity is nullable and its CHECK accepts NULL and the six severities, rejecting anything else", async () => {
        const [col] = await sql<{ is_nullable: string }[]>`
          SELECT is_nullable FROM information_schema.columns
          WHERE table_schema = 'rating' AND table_name = 'event_catalog'
            AND column_name = 'default_severity'
        `;
        expect(col?.is_nullable).toBe("YES");

        const probe = (severity: string | null) =>
          sql`
            INSERT INTO rating.event_catalog ${sql({
              event_code: "CHECK_PROBE",
              default_severity: severity,
              description: "probe row",
            })}
          `;
        const cleanup = () =>
          sql`DELETE FROM rating.event_catalog WHERE event_code = 'CHECK_PROBE'`;

        // NULL is accepted.
        await expect(probe(null)).resolves.toBeDefined();
        await cleanup();
        // Each of the six X.733 values is accepted.
        for (const severity of ALLOWED_SEVERITIES) {
          await expect(probe(severity)).resolves.toBeDefined();
          await cleanup();
        }
        // Anything else is rejected by the CHECK.
        await expect(probe("BOGUS")).rejects.toThrow(/severity_check/);
      });

      it("2. the severity vocabulary is identical to process_log_severity_check", async () => {
        // Scope to the parent relations: process_log is partitioned, so its
        // CHECK is inherited by process_log_default and pg_constraint would
        // otherwise return the child copy too.
        const defs = await sql<{ conname: string; def: string }[]>`
          SELECT c.conname, pg_get_constraintdef(c.oid) AS def
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = 'rating'
            AND t.relname IN ('event_catalog', 'process_log')
            AND c.conname IN (
              'event_catalog_default_severity_check', 'process_log_severity_check'
            )
        `;
        expect(defs).toHaveLength(2);
        const values = (def: string) =>
          (def.match(/'([A-Z]+)'/g) ?? []).map((s) => s.replaceAll("'", ""));
        const byName = Object.fromEntries(defs.map((d) => [d.conname, d.def]));
        const catalogVocab = new Set(
          values(byName.event_catalog_default_severity_check!),
        );
        const logVocab = new Set(values(byName.process_log_severity_check!));
        expect([...catalogVocab].sort()).toEqual(
          [...ALLOWED_SEVERITIES].sort(),
        );
        expect([...catalogVocab].sort()).toEqual([...logVocab].sort());
      });
    });

    describe("catalog completeness", () => {
      it("3. all sixteen codes are present after the seed runs", async () => {
        const rows = await allRows();
        expect(rows).toHaveLength(16);
      });

      it("4. RATING_EVENT_CODES and the seeded rows are the same set in both directions", async () => {
        const rows = await allRows();
        const seeded = new Set(rows.map((r) => r.event_code));
        const constant = new Set<string>(RATING_EVENT_CODES);
        expect([...seeded].sort()).toEqual([...constant].sort());
        // Both directions explicitly: nothing in the constant is unseeded, and
        // nothing seeded is missing from the constant.
        for (const code of RATING_EVENT_CODES)
          expect(seeded.has(code)).toBe(true);
        for (const code of seeded) expect(constant.has(code)).toBe(true);
        // INDETERMINATE is never a code (rm02-spec §Implementation §2).
        expect(seeded.has("INDETERMINATE")).toBe(false);
      });

      it("5. every row has a non-null description, event_type, probable_cause and is_active", async () => {
        const rows = await allRows();
        for (const r of rows) {
          expect(r.description).not.toBeNull();
          expect(r.event_type).not.toBeNull();
          expect(r.probable_cause).not.toBeNull();
          expect(r.is_active).toBe(true);
        }
      });

      it("6. exactly one row (BATCH_COMPLETE) has NULL severity; CLEARED carries 'CLEARED'", async () => {
        const rows = await allRows();
        const nullSeverity = rows.filter((r) => r.default_severity === null);
        expect(nullSeverity.map((r) => r.event_code)).toEqual([
          "BATCH_COMPLETE",
        ]);
        const cleared = rows.find((r) => r.event_code === "CLEARED");
        expect(cleared?.default_severity).toBe("CLEARED");
      });

      it("7. every component is NULL or one of PRP/RP/RL/LOG_SWEEP/SCHEDULER", async () => {
        const allowed = new Set(["PRP", "RP", "RL", "LOG_SWEEP", "SCHEDULER"]);
        const rows = await allRows();
        for (const r of rows) {
          if (r.component !== null) expect(allowed.has(r.component)).toBe(true);
        }
      });
    });

    describe("clearing integrity (D5, D6)", () => {
      it("8. every row is one of the two permitted clearing shapes", async () => {
        const rows = await allRows();
        for (const r of rows) {
          if (r.is_auto_clearing) {
            expect(r.clear_event_code).not.toBeNull();
          } else {
            expect(r.clear_event_code).toBeNull();
          }
        }
      });

      it("9. every non-null clear_event_code names a code that exists in the catalog", async () => {
        const rows = await allRows();
        const codes = new Set(rows.map((r) => r.event_code));
        for (const r of rows) {
          if (r.clear_event_code !== null) {
            expect(codes.has(r.clear_event_code)).toBe(true);
          }
        }
      });

      it("10. the seven human-resolved / informational codes are not auto-clearing", async () => {
        const rows = await allRows();
        const byCode = Object.fromEntries(rows.map((r) => [r.event_code, r]));
        for (const code of NON_AUTO_CLEARING) {
          expect(byCode[code]?.is_auto_clearing).toBe(false);
        }
      });

      it("11. no clearer other than BATCH_COMPLETE; exactly seven rows name it; BATCH_COMPLETE and CLEARED are not auto-cleared", async () => {
        const rows = await allRows();
        const clearers = rows
          .map((r) => r.clear_event_code)
          .filter((c): c is string => c !== null);
        expect(new Set(clearers)).toEqual(new Set(["BATCH_COMPLETE"]));
        expect(clearers).toHaveLength(7);

        const byCode = Object.fromEntries(rows.map((r) => [r.event_code, r]));
        expect(byCode.BATCH_COMPLETE?.is_auto_clearing).toBe(false);
        expect(byCode.CLEARED?.is_auto_clearing).toBe(false);
      });
    });

    describe("severity resolution (§A1)", () => {
      it("12. a known alarming code resolves to its catalogued severity, event type and probable cause", async () => {
        const resolved = await resolve("RECON_IMBALANCE");
        expect(resolved).toEqual({
          perceived_severity: "CRITICAL",
          event_type: "processingErrorAlarm",
          probable_cause: "corruptData",
        });
      });

      it("13+14. BATCH_COMPLETE resolves to NULL and an unknown code to INDETERMINATE — both rows still written", async () => {
        // The pair a COALESCE(default_severity,'INDETERMINATE') implementation
        // collapses into one; run them together (rm02-spec §Verification 14).
        const batchId = "UDRBAT-RM02-1314";
        const cleanSeverity = await writeResolvedLog("BATCH_COMPLETE", batchId);
        const unknownSeverity = await writeResolvedLog(
          "TOTALLY_UNCATALOGUED",
          batchId,
        );
        expect(cleanSeverity).toBeNull();
        expect(unknownSeverity).toBe("INDETERMINATE");

        const written = await sql<
          { event_code: string; perceived_severity: string | null }[]
        >`
          SELECT event_code, perceived_severity FROM rating.process_log
          WHERE batch_id = ${batchId} ORDER BY event_code
        `;
        expect(written).toHaveLength(2);
        const byCode = Object.fromEntries(
          written.map((r) => [r.event_code, r.perceived_severity]),
        );
        expect(byCode.BATCH_COMPLETE).toBeNull();
        expect(byCode.TOTALLY_UNCATALOGUED).toBe("INDETERMINATE");
      });

      it("15. an is_active = false code is resolved as uncatalogued (INDETERMINATE), not its stored severity", async () => {
        await sql`
          INSERT INTO rating.event_catalog ${sql({
            event_code: "RETIRED_PROBE",
            default_severity: "MAJOR",
            event_type: "processingErrorAlarm",
            probable_cause: "corruptData",
            description: "retired probe",
            is_active: false,
          })}
        `;
        try {
          const resolved = await resolve("RETIRED_PROBE");
          expect(resolved.perceived_severity).toBe("INDETERMINATE");
        } finally {
          await sql`DELETE FROM rating.event_catalog WHERE event_code = 'RETIRED_PROBE'`;
        }
      });

      it("16. counting INDETERMINATE over a run of only catalogued codes returns zero, including BATCH_COMPLETE", async () => {
        const batchId = "UDRBAT-RM02-16";
        for (const code of [
          "DB_WRITE_FAILURE",
          "FILE_LATE",
          "BATCH_PARTIAL",
          "BATCH_COMPLETE",
          "CLEARED",
        ]) {
          await writeResolvedLog(code, batchId);
        }
        const [row] = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM rating.process_log
          WHERE batch_id = ${batchId} AND perceived_severity = 'INDETERMINATE'
        `;
        expect(row?.n).toBe(0);
      });
    });

    describe("idempotency", () => {
      it("17. running the seed twice leaves sixteen rows, not thirty-two", async () => {
        await seedEventCatalog(db);
        const rows = await allRows();
        expect(rows).toHaveLength(16);
      });

      it("18. changing a severity and re-running the upsert updates the existing row (DO UPDATE, not DO NOTHING)", async () => {
        // Mutate the stored row to a wrong value, then let the canonical seed
        // reassert it. DO NOTHING would leave the wrong value in place.
        await sql`UPDATE rating.event_catalog SET default_severity = 'WARNING' WHERE event_code = 'DB_WRITE_FAILURE'`;
        await seedEventCatalog(db);
        const [row] = await sql<{ default_severity: string | null }[]>`
          SELECT default_severity FROM rating.event_catalog WHERE event_code = 'DB_WRITE_FAILURE'
        `;
        expect(row?.default_severity).toBe("CRITICAL");
      });

      it("19. re-running a seed whose severity is NULL sets the stored value to NULL (downgrade out of the alarm stream)", async () => {
        const canonical = EVENT_CATALOG_SEED.find(
          (r) => r.eventCode === "DB_WRITE_FAILURE",
        )!;
        // A one-off upsert with the same mechanism, severity nulled — proving a
        // value CAN be set back to NULL, not only re-tuned within the enum.
        await db
          .insert(eventCatalog)
          .values([{ ...canonical, defaultSeverity: null }])
          .onConflictDoUpdate({
            target: eventCatalog.eventCode,
            set: { defaultSeverity: dsql`excluded.default_severity` },
          });
        const [row] = await sql<{ default_severity: string | null }[]>`
          SELECT default_severity FROM rating.event_catalog WHERE event_code = 'DB_WRITE_FAILURE'
        `;
        expect(row?.default_severity).toBeNull();
        // Restore canonical state for any later assertion.
        await seedEventCatalog(db);
      });

      it("20. the seed does not delete or deactivate a code absent from its list", async () => {
        await sql`
          INSERT INTO rating.event_catalog ${sql({
            event_code: "LEGACY_RETIRED",
            default_severity: null,
            description: "a code retired by a hypothetical later migration",
            is_active: false,
          })}
        `;
        try {
          await seedEventCatalog(db);
          const [row] = await sql<{ is_active: boolean }[]>`
            SELECT is_active FROM rating.event_catalog WHERE event_code = 'LEGACY_RETIRED'
          `;
          expect(row?.is_active).toBe(false);
        } finally {
          await sql`DELETE FROM rating.event_catalog WHERE event_code = 'LEGACY_RETIRED'`;
        }
      });
    });

    describe("build hygiene", () => {
      it("23. no core.permissions row was added for this module", async () => {
        const rows = await sql<{ permission_name: string }[]>`
          SELECT permission_name FROM core.permissions
          WHERE permission_name ILIKE '%event%catalog%'
             OR permission_name ILIKE '%rating%'
        `;
        expect(rows).toHaveLength(0);
      });
    });
  },
);
