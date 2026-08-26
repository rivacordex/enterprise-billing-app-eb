import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import type { Database } from "@/db/client";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// rm03-spec §Implementation §4 + §Verification checklist. The grant surface is
// the deliverable, so every assertion runs against a LIVE database and — where
// the spec says "only a real statement proves the ACL is what governs" — via a
// LIVE CONNECTION PER ROLE, not just has_*_privilege() from the superuser. Both
// are asserted (the ACL and the statement it governs).
//
// Named `.integration.test.ts` (not the spec's literal `grants.test.ts`) so
// vitest.integration.config.ts's include glob picks it up; a bare `.test.ts`
// lands in the DB-free default project and would only ever skip. Same choice
// rm01/rm02 made — see the progress-tracker Open Questions.
//
// DATABASE_URL must be a SUPERUSER/OWNER connection here: the suite creates
// login roles, sets their passwords, runs both bootstrap SQL files, and opens
// per-role connections. The disposable test container's DATABASE_URL is the
// `postgres` superuser, exactly as this needs.
const databaseUrl = process.env.DATABASE_URL;

// Throwaway passwords for the ephemeral test container — never real infra, the
// same posture as .env.test's committed localhost credentials. The bootstrap
// SQL deliberately ships no password (rm03-spec D10); the suite supplies one
// only so it can open a real TCP connection per role.
const ROLE_PW = "rm03-test-only-pw";

const BOOTSTRAP_ROLES_SQL = join(
  process.cwd(),
  "db/bootstrap/bootstrap-db-roles.sql",
);
const RATING_ROLES_SQL = join(
  process.cwd(),
  "db/bootstrap/rating-db-roles.sql",
);

// The six columns app_runtime may UPDATE on udr_rated (rm03-spec D1); `status`
// is the only one rating_runtime may also update.
const APP_UPDATABLE = [
  "status",
  "billrun_ref_id",
  "billrun_ban_id",
  "billrun_attempt",
  "billrun_checksum",
  "upsert_datetime",
].sort();
const ENG_UPDATABLE = ["status"];

function roleUrl(base: string, user: string, password: string): string {
  const url = new URL(base);
  url.username = user;
  url.password = password;
  return url.toString();
}

function statements(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function runSqlFile(client: postgresjs.Sql, path: string): Promise<void> {
  for (const statement of statements(path)) {
    await client.unsafe(statement);
  }
}

describe.skipIf(!databaseUrl)(
  "rating_runtime role grants (rm03-spec, requires a superuser DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql; // superuser/owner
    let ratingRuntime: postgresjs.Sql;
    let appRuntime: postgresjs.Sql;
    let appMigrate: postgresjs.Sql;
    let db: Database;

    // Monotonic suffix so each test operates on its own udr_rated / udr_batch
    // row and cannot disturb another's status/is_live.
    let seq = 0;
    const nextKey = (p: string) => `${p}-${(seq += 1)}`;

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

    // A valid udr_rated row (rm01 DDL): partition_period must equal
    // period_of(start_datetime) = date_trunc('month', start AT TIME ZONE UTC).
    const ratedRow = () => ({
      partition_period: "2026-08-01",
      udr_type: "USAGE",
      start_datetime: "2026-08-14T10:00:00Z",
      end_datetime: "2026-08-14T11:00:00Z",
      udr_subscriber_ref_id: "SUB-1",
      udr_key: nextKey("KEY"),
      udr_usage_quantity: "1.000000",
      udr_usage_unit: "CALL",
      udr_rate_type: "FLAT",
      udr_rated_price: "1.00",
      udr_rated_price_raw: "1.000000",
      udr_rounding_mode: "HALF_UP",
      udr_currency: "USD",
      udr_ref_batch_id: "UDRBAT-TEST",
      udr_source_file: "test.csv",
      rating_engine_version: "v1",
      rating_flow_revision: 1,
    });

    // Insert a udr_rated row as the superuser and return its PK so a role test
    // can target exactly one row.
    async function insertRatedRow(): Promise<{ period: string; id: string }> {
      const [row] = await sql<{ partition_period: string; udr_id: string }[]>`
        INSERT INTO rating.udr_rated ${sql(ratedRow())}
        RETURNING partition_period, udr_id
      `;
      return { period: row!.partition_period, id: row!.udr_id };
    }

    async function insertBatchRow(): Promise<string> {
      const [row] = await sql<{ batch_id: string }[]>`
        INSERT INTO rating.udr_batch ${sql({
          file_key: nextKey("FK"),
          source_file: "s.csv",
          file_key_rule: "rule-1",
          udr_type: "USAGE",
        })}
        RETURNING batch_id
      `;
      return row!.batch_id;
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
      await dropAll(sql);
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      // Provisioning order (infra/docs/db-role-verification.md): the platform
      // roles first, then the rating boundary that references them.
      await runSqlFile(sql, BOOTSTRAP_ROLES_SQL);
      await runSqlFile(sql, RATING_ROLES_SQL);

      // Give the login roles a password so the suite can connect as each. A
      // no-grant probe role exercises the Inv #18 CONNECT boundary.
      await sql.unsafe(`ALTER ROLE app_runtime    WITH PASSWORD '${ROLE_PW}'`);
      await sql.unsafe(`ALTER ROLE app_migrate    WITH PASSWORD '${ROLE_PW}'`);
      await sql.unsafe(`ALTER ROLE rating_runtime WITH PASSWORD '${ROLE_PW}'`);
      await sql.unsafe('DROP ROLE IF EXISTS "rm03_grant_probe"');
      await sql.unsafe(
        `CREATE ROLE rm03_grant_probe WITH LOGIN PASSWORD '${ROLE_PW}'`,
      );

      ratingRuntime = postgres(
        roleUrl(databaseUrl as string, "rating_runtime", ROLE_PW),
        { max: 1 },
      );
      appRuntime = postgres(
        roleUrl(databaseUrl as string, "app_runtime", ROLE_PW),
        { max: 1 },
      );
      appMigrate = postgres(
        roleUrl(databaseUrl as string, "app_migrate", ROLE_PW),
        { max: 1 },
      );
    }, 120_000);

    afterAll(async () => {
      await ratingRuntime?.end();
      await appRuntime?.end();
      await appMigrate?.end();
      if (sql) {
        await dropAll(sql);
        await sql.unsafe('DROP ROLE IF EXISTS "rm03_grant_probe"');
        await sql.end();
      }
    });

    // ---- Column boundary — app_runtime (Inv #2) ----------------------------
    describe("column boundary — app_runtime (Inv #2)", () => {
      it("1. updates each of the six permitted columns individually — six statements, six successes", async () => {
        const { period, id } = await insertRatedRow();
        const sets: string[] = [
          "status = 'BILL_DRAFT'",
          "billrun_ref_id = 'BR-1'",
          "billrun_ban_id = 'BAN-1'",
          "billrun_attempt = 1",
          "billrun_checksum = 'CHK'",
          "upsert_datetime = now()",
        ];
        for (const assignment of sets) {
          await expect(
            appRuntime.unsafe(
              `UPDATE rating.udr_rated SET ${assignment} WHERE partition_period = $1 AND udr_id = $2`,
              [period, id],
            ),
          ).resolves.toBeDefined();
        }
      });

      it("2–3. updating any money/identity column is refused per column (permission denied for table)", async () => {
        const { period, id } = await insertRatedRow();
        for (const col of [
          "udr_rated_price",
          "udr_usage_rate",
          "udr_discount_amount",
          "udr_currency",
          "udr_key",
          "start_datetime",
          "rating_engine_version",
        ]) {
          await expect(
            appRuntime.unsafe(
              `UPDATE rating.udr_rated SET ${col} = ${
                col === "billrun_attempt" ? "1" : "NULL"
              } WHERE partition_period = $1 AND udr_id = $2`,
              [period, id],
            ),
          ).rejects.toThrow(/permission denied for table udr_rated/);
        }
      });

      it("4. INSERT into udr_rated is refused", async () => {
        await expect(
          appRuntime`INSERT INTO rating.udr_rated ${appRuntime(ratedRow())}`,
        ).rejects.toThrow(/permission denied/);
      });

      it("5. DELETE from udr_rated is refused", async () => {
        await expect(
          appRuntime`DELETE FROM rating.udr_rated WHERE false`,
        ).rejects.toThrow(/permission denied/);
      });

      it("6. the pg_attribute enumeration returns exactly the six app-updatable columns and no others", async () => {
        const rows = await sql<{ attname: string; app_upd: boolean }[]>`
          SELECT a.attname,
                 has_column_privilege('app_runtime','rating.udr_rated', a.attname, 'UPDATE') AS app_upd
          FROM pg_attribute a
          WHERE a.attrelid = 'rating.udr_rated'::regclass
            AND a.attnum > 0 AND NOT a.attisdropped
        `;
        const updatable = rows
          .filter((r) => r.app_upd)
          .map((r) => r.attname)
          .sort();
        expect(updatable).toEqual(APP_UPDATABLE);
      });

      it("7. is_live is not app-updatable (D4), yet updating status still succeeds", async () => {
        const [priv] = await sql<{ p: boolean }[]>`
          SELECT has_column_privilege('app_runtime','rating.udr_rated','is_live','UPDATE') AS p
        `;
        expect(priv?.p).toBe(false);
        const { period, id } = await insertRatedRow();
        await expect(
          appRuntime.unsafe(
            `UPDATE rating.udr_rated SET status = 'BILL_APPROVED' WHERE partition_period = $1 AND udr_id = $2`,
            [period, id],
          ),
        ).resolves.toBeDefined();
      });
    });

    // ---- Column boundary — rating_runtime (Inv #2) -------------------------
    describe("column boundary — rating_runtime (Inv #2)", () => {
      it("6b. the pg_attribute enumeration returns exactly `status` as engine-updatable on udr_rated", async () => {
        const rows = await sql<{ attname: string; eng_upd: boolean }[]>`
          SELECT a.attname,
                 has_column_privilege('rating_runtime','rating.udr_rated', a.attname, 'UPDATE') AS eng_upd
          FROM pg_attribute a
          WHERE a.attrelid = 'rating.udr_rated'::regclass
            AND a.attnum > 0 AND NOT a.attisdropped
        `;
        const updatable = rows
          .filter((r) => r.eng_upd)
          .map((r) => r.attname)
          .sort();
        expect(updatable).toEqual(ENG_UPDATABLE);
      });

      it("8. updates status (SUPERSEDED) — succeeds; updating udr_ref_batch_id is refused (lineage write-once)", async () => {
        const { period, id } = await insertRatedRow();
        await expect(
          ratingRuntime.unsafe(
            `UPDATE rating.udr_rated SET status = 'SUPERSEDED' WHERE partition_period = $1 AND udr_id = $2`,
            [period, id],
          ),
        ).resolves.toBeDefined();
        await expect(
          ratingRuntime.unsafe(
            `UPDATE rating.udr_rated SET udr_ref_batch_id = 'X' WHERE partition_period = $1 AND udr_id = $2`,
            [period, id],
          ),
        ).rejects.toThrow(/permission denied for table udr_rated/);
      });

      it("9–10. updating billrun_ref_id and udr_rated_price is refused — the boundary holds both directions", async () => {
        const { period, id } = await insertRatedRow();
        for (const col of ["billrun_ref_id", "udr_rated_price"]) {
          await expect(
            ratingRuntime.unsafe(
              `UPDATE rating.udr_rated SET ${col} = NULL WHERE partition_period = $1 AND udr_id = $2`,
              [period, id],
            ),
          ).rejects.toThrow(/permission denied for table udr_rated/);
        }
      });

      it("11. rating_runtime holds no DELETE and no TRUNCATE on any rating table", async () => {
        for (const table of [
          "udr_rated",
          "udr_batch",
          "process_log",
          "event_catalog",
        ]) {
          const [row] = await sql<{ del: boolean; trunc: boolean }[]>`
            SELECT has_table_privilege('rating_runtime', ${"rating." + table}, 'DELETE') AS del,
                   has_table_privilege('rating_runtime', ${"rating." + table}, 'TRUNCATE') AS trunc
          `;
          expect(row?.del).toBe(false);
          expect(row?.trunc).toBe(false);
        }
        await expect(
          ratingRuntime`DELETE FROM rating.udr_rated WHERE false`,
        ).rejects.toThrow(/permission denied/);
        await expect(ratingRuntime`TRUNCATE rating.udr_rated`).rejects.toThrow(
          /permission denied/,
        );
      });

      it("12. cannot UPDATE udr_batch.file_key / .batch_run_num / .batch_id (the claim cannot be edited around, Inv #7)", async () => {
        for (const col of ["file_key", "batch_run_num", "batch_id"]) {
          const [row] = await sql<{ p: boolean }[]>`
            SELECT has_column_privilege('rating_runtime','rating.udr_batch', ${col}, 'UPDATE') AS p
          `;
          expect(row?.p).toBe(false);
        }
        const batchId = await insertBatchRow();
        await expect(
          ratingRuntime.unsafe(
            `UPDATE rating.udr_batch SET file_key = 'X' WHERE batch_id = $1`,
            [batchId],
          ),
        ).rejects.toThrow(/permission denied for table udr_batch/);
        // A lifecycle column IS updatable.
        await expect(
          ratingRuntime.unsafe(
            `UPDATE rating.udr_batch SET status = 'PROCESSING' WHERE batch_id = $1`,
            [batchId],
          ),
        ).resolves.toBeDefined();
      });
    });

    // ---- Partitioning (Inv #17a) ------------------------------------------
    describe("partitioning (Inv #17a)", () => {
      it("13. app_runtime updates a permitted column on a row in a partition, addressed through the parent — succeeds", async () => {
        const { period, id } = await insertRatedRow();
        await expect(
          appRuntime.unsafe(
            `UPDATE rating.udr_rated SET status = 'BILL_DRAFT' WHERE partition_period = $1 AND udr_id = $2`,
            [period, id],
          ),
        ).resolves.toBeDefined();
      });

      it("14. addressing the partition directly is refused for both SELECT and UPDATE, for both roles", async () => {
        for (const client of [appRuntime, ratingRuntime]) {
          await expect(
            client`SELECT 1 FROM rating.udr_rated_default WHERE false`,
          ).rejects.toThrow(
            /permission denied for (table|relation) udr_rated_default/,
          );
          await expect(
            client`UPDATE rating.udr_rated_default SET status = 'RATED' WHERE false`,
          ).rejects.toThrow(
            /permission denied for (table|relation) udr_rated_default/,
          );
        }
      });

      it("16. no partition of udr_rated or process_log carries an ACL entry for either role — grants live on the parent only", async () => {
        const rows = await sql<{ relname: string; relacl: string | null }[]>`
          SELECT c.relname, c.relacl::text AS relacl
          FROM pg_inherits i
          JOIN pg_class c ON c.oid = i.inhrelid
          JOIN pg_class p ON p.oid = i.inhparent
          JOIN pg_namespace n ON n.oid = p.relnamespace
          WHERE n.nspname = 'rating'
            AND p.relname IN ('udr_rated', 'process_log')
        `;
        expect(rows.length).toBeGreaterThan(0); // the two _default partitions exist
        for (const r of rows) {
          if (r.relacl) {
            expect(r.relacl).not.toContain("rating_runtime");
            expect(r.relacl).not.toContain("app_runtime");
          }
        }
      });
    });

    // ---- Insert prerequisites (D8) ----------------------------------------
    describe("insert prerequisites (D8)", () => {
      it("18. rating_runtime inserts into udr_batch and the batch_id default fires (USAGE ON SEQUENCE)", async () => {
        const [row] = await ratingRuntime<{ batch_id: string }[]>`
          INSERT INTO rating.udr_batch ${ratingRuntime({
            file_key: nextKey("FK"),
            source_file: "s.csv",
            file_key_rule: "rule-1",
            udr_type: "USAGE",
          })}
          RETURNING batch_id
        `;
        expect(row?.batch_id).toMatch(/^UDRBAT\d{8}$/);
      });

      it("19. rating_runtime inserts into udr_rated — the period_of CHECK and generate_ulid default both evaluate", async () => {
        const [row] = await ratingRuntime<{ udr_id: string }[]>`
          INSERT INTO rating.udr_rated ${ratingRuntime(ratedRow())}
          RETURNING udr_id
        `;
        expect(row?.udr_id).toBeTruthy();
      });

      it("20. rating_runtime inserts into process_log and the core.generate_ulid() default fires", async () => {
        const [row] = await ratingRuntime<{ log_id: string }[]>`
          INSERT INTO rating.process_log ${ratingRuntime({
            partition_period: "2026-08-01",
            log_datetime: "2026-08-14T10:00:00Z",
            component: "RL",
            log_level: "INFO",
            event_code: "BATCH_COMPLETE",
          })}
          RETURNING log_id
        `;
        expect(row?.log_id).toBeTruthy();
      });
    });

    // ---- The billing boundary (Inv #1) ------------------------------------
    describe("the billing boundary (Inv #1)", () => {
      it("22. rating_runtime SELECTs billing.billing_account and billing.bill_cycle successfully", async () => {
        await expect(
          ratingRuntime`SELECT 1 FROM billing.billing_account WHERE false`,
        ).resolves.toBeDefined();
        await expect(
          ratingRuntime`SELECT 1 FROM billing.bill_cycle WHERE false`,
        ).resolves.toBeDefined();
      });

      it("23–24. UPDATE and INSERT on billing.billing_account are refused", async () => {
        // Self-assign a real column so the statement resolves past name analysis
        // and actually reaches the UPDATE-privilege check (which is refused).
        await expect(
          ratingRuntime`UPDATE billing.billing_account SET billing_account_id = billing_account_id WHERE false`,
        ).rejects.toThrow(/permission denied/);
        await expect(
          ratingRuntime`INSERT INTO billing.billing_account DEFAULT VALUES`,
        ).rejects.toThrow(/permission denied/);
      });

      it("25. SELECT on a billing table NOT in the enumerated list (billing.document) is refused — grant is per-table", async () => {
        await expect(
          ratingRuntime`SELECT 1 FROM billing.document WHERE false`,
        ).rejects.toThrow(/permission denied/);
      });

      it("26. rating_runtime calling billing.pgledger_create_transfer(...) is refused with permission denied for function (D7)", async () => {
        await expect(
          ratingRuntime`SELECT billing.pgledger_create_transfer('a', 'b', 1::numeric, now(), '{}'::jsonb)`,
        ).rejects.toThrow(/permission denied for function/);
      });

      it("27. app_runtime retains EXECUTE on the four pgledger definer functions after the revoke", async () => {
        const rows = await sql<{ fn: string; app_exec: boolean }[]>`
          SELECT p.oid::regprocedure::text AS fn,
                 has_function_privilege('app_runtime', p.oid, 'EXECUTE') AS app_exec
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'billing' AND p.proname LIKE 'pgledger_create_%'
        `;
        expect(rows.length).toBeGreaterThanOrEqual(4);
        for (const r of rows) expect(r.app_exec).toBe(true);
      });

      it("28. standing assertion: no billing SECURITY DEFINER function is executable by PUBLIC", async () => {
        const rows = await sql<{ fn: string }[]>`
          SELECT p.oid::regprocedure AS fn
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'billing'
            AND p.prosecdef
            AND has_function_privilege('public', p.oid, 'EXECUTE')
        `;
        expect(rows).toEqual([]);
      });
    });

    // ---- Connection boundary (Inv #18 precondition) -----------------------
    describe("connection boundary (Inv #18 precondition)", () => {
      it("29. the database ACL is non-null and grants PUBLIC no CONNECT", async () => {
        const [row] = await sql<{ datacl: string | null; pub: boolean }[]>`
          SELECT datacl::text AS datacl,
                 has_database_privilege('public', current_database(), 'CONNECT') AS pub
          FROM pg_database WHERE datname = current_database()
        `;
        expect(row?.datacl).not.toBeNull();
        expect(row?.pub).toBe(false);
      });

      it("30. a role with no explicit CONNECT is refused with permission denied for database", async () => {
        const probe = postgres(
          roleUrl(databaseUrl as string, "rm03_grant_probe", ROLE_PW),
          { max: 1 },
        );
        try {
          await expect(probe`SELECT 1`).rejects.toThrow(
            /permission denied for database/,
          );
        } finally {
          await probe.end();
        }
      });

      it("31. rating_runtime, app_runtime and app_migrate all connect successfully after the revoke", async () => {
        for (const client of [ratingRuntime, appRuntime, appMigrate]) {
          const [row] = await client<{ ok: number }[]>`SELECT 1 AS ok`;
          expect(row?.ok).toBe(1);
        }
      });

      it("32. rolconnlimit on rating_runtime equals the configured 20", async () => {
        const [row] = await sql<{ rolconnlimit: number }[]>`
          SELECT rolconnlimit FROM pg_roles WHERE rolname = 'rating_runtime'
        `;
        expect(row?.rolconnlimit).toBe(20);
      });
    });

    // ---- Default privileges (D5) ------------------------------------------
    describe("default privileges (D5)", () => {
      it("33. a table created in rating by app_migrate gives both roles SELECT and nothing else", async () => {
        await appMigrate.unsafe(
          "CREATE TABLE rating.rm03_probe (id integer PRIMARY KEY)",
        );
        try {
          for (const role of ["rating_runtime", "app_runtime"]) {
            const [row] = await sql<
              {
                sel: boolean;
                ins: boolean;
                upd: boolean;
                del: boolean;
              }[]
            >`
              SELECT has_table_privilege(${role}, 'rating.rm03_probe', 'SELECT') AS sel,
                     has_table_privilege(${role}, 'rating.rm03_probe', 'INSERT') AS ins,
                     has_table_privilege(${role}, 'rating.rm03_probe', 'UPDATE') AS upd,
                     has_table_privilege(${role}, 'rating.rm03_probe', 'DELETE') AS del
            `;
            expect(row?.sel).toBe(true);
            expect(row?.ins).toBe(false);
            expect(row?.upd).toBe(false);
            expect(row?.del).toBe(false);
          }
        } finally {
          await appMigrate.unsafe("DROP TABLE rating.rm03_probe");
        }
      });

      it("34. ALTER DEFAULT PRIVILEGES ... GRANT UPDATE (col) is rejected by Postgres (why item 33 is written that way)", async () => {
        await expect(
          sql.unsafe(
            'ALTER DEFAULT PRIVILEGES IN SCHEMA "rating" GRANT UPDATE (status) ON TABLES TO app_runtime',
          ),
        ).rejects.toThrow(/cannot be set for columns/);
      });
    });

    // ---- Idempotency and hygiene ------------------------------------------
    describe("idempotency and hygiene", () => {
      it("35–36. re-running the script converges — no error, connlimit still 20, the enumeration byte-identical", async () => {
        const enumerate = () => sql<
          { attname: string; app_upd: boolean; eng_upd: boolean }[]
        >`
          SELECT a.attname,
                 has_column_privilege('app_runtime','rating.udr_rated', a.attname, 'UPDATE') AS app_upd,
                 has_column_privilege('rating_runtime','rating.udr_rated', a.attname, 'UPDATE') AS eng_upd
          FROM pg_attribute a
          WHERE a.attrelid = 'rating.udr_rated'::regclass
            AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum
        `;
        const before = await enumerate();
        await runSqlFile(sql, RATING_ROLES_SQL);
        const after = await enumerate();
        expect(after).toEqual(before);
        const [row] = await sql<{ rolconnlimit: number }[]>`
          SELECT rolconnlimit FROM pg_roles WHERE rolname = 'rating_runtime'
        `;
        expect(row?.rolconnlimit).toBe(20);
      });

      it("39. no core.permissions row, no page, no route for this module", async () => {
        const rows = await sql<{ permission_name: string }[]>`
          SELECT permission_name FROM core.permissions
          WHERE permission_name ILIKE '%rating%'
        `;
        expect(rows).toHaveLength(0);
      });
    });
  },
);
