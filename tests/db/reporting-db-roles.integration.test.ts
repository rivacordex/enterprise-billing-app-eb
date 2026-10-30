import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// rpt01-spec Tests R01-T1–R01-T8 (rptmgmt-code-standards §9 guardrail 1). The
// grant surface is the deliverable, so every assertion runs against a LIVE
// database through a LIVE `reporting_runtime` connection — the posture of
// tests/db/billrun-db-roles.integration.test.ts, which this suite mirrors.
//
// DATABASE_URL must be a SUPERUSER/OWNER connection on a THROWAWAY cluster:
// the suite drops and re-migrates every schema, creates login roles, sets
// `reporting_runtime`'s password to a test value (roles are cluster-level),
// and creates/drops a scratch database.
const databaseUrl = process.env.DATABASE_URL;

const ROLE_PW = "rpt01-test-only-pw";
const ROLE = "reporting_runtime";
const SCRATCH_DB = "rpt01_ordering_scratch";
const DRIFT_PROBE_ROLE = "rpt01_drift_probe";

const sqlPath = (name: string) => join(process.cwd(), "db/bootstrap", name);
const BOOTSTRAP_ROLES_SQL = sqlPath("bootstrap-db-roles.sql");
const RATING_ROLES_SQL = sqlPath("rating-db-roles.sql");
const BILLRUN_ROLES_SQL = sqlPath("billrun-db-roles.sql");
const REPORTING_ROLES_SQL = sqlPath("reporting-db-roles.sql");
const KESTRA_ROLES_SQL = sqlPath("kestra-db-roles.sql");

// D2 — the nine tables, and nothing else.
const GRANTED_TABLES = [
  "billing.billing_account",
  "billing.customer_bill",
  "billing.document",
  "billing.document_line",
  "billing.financial_account",
  "billing.ledger_binding",
  "customer.party_role",
  "product.ratecard_ran_usage_lkp",
  "product.ratecard_version",
];

function roleUrl(base: string, user: string, password: string): string {
  const url = new URL(base);
  url.username = user;
  url.password = password;
  return url.toString();
}

function withDatabase(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function statements(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Same semantics as db/bootstrap/reporting-db-roles.ts: statements in order,
// stopping at the first error.
async function runSqlFile(client: postgresjs.Sql, path: string): Promise<void> {
  for (const statement of statements(path)) {
    await client.unsafe(statement);
  }
}

// kestra-db-roles.sql's billing-database half only (CREATE DATABASE kestra,
// kestra_engine, REVOKE CONNECT … FROM PUBLIC on kestra) — enough for the
// "no CONNECT on kestra" assertion. Its kestra-database half (schema grants
// to kestra_engine) is irrelevant here. A pre-existing `kestra` database is
// tolerated (42P04) and never modified or dropped by this suite.
const KESTRA_DB_MARKER_LINE = /^--> statement-breakpoint-kestra-db$/m;
const PG_DUPLICATE_DATABASE = "42P04";

async function runKestraBillingHalf(client: postgresjs.Sql): Promise<void> {
  const text = readFileSync(KESTRA_ROLES_SQL, "utf8");
  const match = KESTRA_DB_MARKER_LINE.exec(text);
  const billingText = match ? text.slice(0, match.index) : text;
  for (const statement of billingText
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)) {
    try {
      await client.unsafe(statement);
    } catch (err) {
      if ((err as { code?: string }).code === PG_DUPLICATE_DATABASE) continue;
      throw err;
    }
  }
}

function qualified(table: string): string {
  const [schemaName, tableName] = table.split(".");
  return `"${schemaName}"."${tableName}"`;
}

describe.skipIf(!databaseUrl)(
  "reporting_runtime read-only role (rpt01-spec, requires a superuser DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql; // superuser/owner
    let reporting: postgresjs.Sql; // reporting_runtime, sessions read-only by default

    const dropAll = async (client: postgresjs.Sql) => {
      for (const s of [
        "inventory",
        "ordering",
        "billing",
        "customer",
        "product",
        "rating",
        "core",
        "drizzle",
        "partman",
      ]) {
        await client.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
      }
    };

    async function roleAttributes() {
      const [row] = await sql<
        {
          rolcanlogin: boolean;
          rolsuper: boolean;
          rolcreaterole: boolean;
          rolcreatedb: boolean;
          rolreplication: boolean;
          rolbypassrls: boolean;
          rolconnlimit: number;
          rolconfig: string[] | null;
        }[]
      >`
        SELECT rolcanlogin, rolsuper, rolcreaterole, rolcreatedb,
               rolreplication, rolbypassrls, rolconnlimit, rolconfig
        FROM pg_roles WHERE rolname = ${ROLE}
      `;
      return row;
    }

    // Every table ACL entry for the role, from the catalog itself.
    async function tableAcl(): Promise<string[]> {
      const rows = await sql<{ entry: string }[]>`
        SELECT n.nspname || '.' || c.relname || ':' || a.privilege_type AS entry
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace,
        LATERAL aclexplode(c.relacl) a
        WHERE a.grantee = ${ROLE}::regrole
        ORDER BY 1 COLLATE "C"
      `;
      return rows.map((r) => r.entry);
    }

    // The whole grant surface, for the idempotency comparison (R01-T8).
    async function grantSnapshot() {
      // The role's own schema ACL entries (has_schema_privilege would also
      // report PUBLIC's default USAGE on `public`).
      const schemas = await sql<{ nspname: string }[]>`
        SELECT n.nspname || ':' || a.privilege_type AS nspname
        FROM pg_namespace n, LATERAL aclexplode(n.nspacl) a
        WHERE a.grantee = ${ROLE}::regrole
        ORDER BY 1
      `;
      const [db] = await sql<{ datacl: string }[]>`
        SELECT datacl::text FROM pg_database WHERE datname = current_database()
      `;
      return {
        attributes: await roleAttributes(),
        tables: await tableAcl(),
        schemas: schemas.map((r) => r.nspname),
        datacl: db?.datacl,
      };
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1, onnotice: () => {} });
      await dropAll(sql);
      await migrate(drizzle(sql, { schema }), {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      // D1 provisioning order: roles -> rating-roles -> billrun-roles ->
      // reporting-roles, then kestra-roles as today.
      await runSqlFile(sql, BOOTSTRAP_ROLES_SQL);
      await runSqlFile(sql, RATING_ROLES_SQL);
      await runSqlFile(sql, BILLRUN_ROLES_SQL);
      await runSqlFile(sql, REPORTING_ROLES_SQL);
      await runKestraBillingHalf(sql);

      await sql.unsafe(`ALTER ROLE ${ROLE} WITH PASSWORD '${ROLE_PW}'`);
      reporting = postgres(roleUrl(databaseUrl as string, ROLE, ROLE_PW), {
        max: 1,
      });
    }, 180_000);

    afterAll(async () => {
      await reporting?.end();
      if (sql) {
        await sql.unsafe(`DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
        await dropAll(sql);
        await sql.end();
      }
    }, 120_000);

    // ---- R01-T1 ------------------------------------------------------------
    it("R01-T1 — reporting_runtime: LOGIN, no superuser/createrole/createdb/replication/bypassrls, connection limit 10, default_transaction_read_only = on", async () => {
      const row = await roleAttributes();
      expect(row).toEqual({
        rolcanlogin: true,
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolbypassrls: false,
        rolconnlimit: 10,
        rolconfig: ["default_transaction_read_only=on"],
      });
      // …and a live session really starts read-only.
      const [live] = await reporting<
        { user: string; dtro: string; tro: string }[]
      >`
        SELECT current_user AS user,
               current_setting('default_transaction_read_only') AS dtro,
               current_setting('transaction_read_only') AS tro
      `;
      expect(live).toEqual({ user: ROLE, dtro: "on", tro: "on" });
    });

    // ---- R01-T2 ------------------------------------------------------------
    it("R01-T2 — SELECT succeeds on each of the nine D2 tables", async () => {
      for (const table of GRANTED_TABLES) {
        await expect(
          reporting.unsafe(`SELECT count(*) FROM ${qualified(table)}`),
          table,
        ).resolves.toBeDefined();
      }
    });

    // ---- R01-T3 (guardrail 1) ------------------------------------------------
    it("R01-T3 — [guardrail 1] INSERT, UPDATE, DELETE and TRUNCATE on each of the nine tables are refused by the grants, with read-only turned off for the session", async () => {
      const rw = postgres(roleUrl(databaseUrl as string, ROLE, ROLE_PW), {
        max: 1,
      });
      try {
        // The session setting is off, so it is the GRANT that refuses.
        await rw.unsafe("SET default_transaction_read_only = off");
        const [mode] = await rw<{ tro: string }[]>`
          SELECT current_setting('transaction_read_only') AS tro
        `;
        expect(mode?.tro).toBe("off");

        for (const table of GRANTED_TABLES) {
          const [schemaName, tableName] = table.split(".");
          const [col] = await sql<{ column_name: string }[]>`
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = ${schemaName!} AND table_name = ${tableName!}
            ORDER BY ordinal_position LIMIT 1
          `;
          const t = qualified(table);
          const c = `"${col!.column_name}"`;
          for (const write of [
            `INSERT INTO ${t} DEFAULT VALUES`,
            `UPDATE ${t} SET ${c} = ${c} WHERE false`,
            `DELETE FROM ${t} WHERE false`,
            `TRUNCATE ${t}`,
          ]) {
            await expect(rw.unsafe(write), write).rejects.toThrow(
              /permission denied for table/,
            );
          }
        }
      } finally {
        await rw.end();
      }
    });

    // ---- R01-T4 ------------------------------------------------------------
    describe("R01-T4 — no other access", () => {
      it("SELECT on a non-granted table is refused (billing.gl_mapping, rating.udr_rated)", async () => {
        await expect(
          reporting`SELECT 1 FROM billing.gl_mapping LIMIT 1`,
        ).rejects.toThrow(/permission denied for table gl_mapping/);
        // No USAGE on `rating` at all until rpt08.
        await expect(
          reporting`SELECT 1 FROM rating.udr_rated LIMIT 1`,
        ).rejects.toThrow(/permission denied for schema rating/);
      });

      it("EXECUTE on billing.pgledger_create_transfer is refused", async () => {
        const rw = postgres(roleUrl(databaseUrl as string, ROLE, ROLE_PW), {
          max: 1,
        });
        try {
          await rw.unsafe("SET default_transaction_read_only = off");
          await expect(
            rw`SELECT billing.pgledger_create_transfer('a', 'b', 1::numeric, now(), '{}'::jsonb)`,
          ).rejects.toThrow(/permission denied for function/);
        } finally {
          await rw.end();
        }
      });

      it("CONNECT to the kestra database is refused", async () => {
        const probe = postgres(
          roleUrl(withDatabase(databaseUrl as string, "kestra"), ROLE, ROLE_PW),
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
    });

    // ---- R01-T5 ------------------------------------------------------------
    describe("R01-T5 — no broad grants", () => {
      it("information_schema.role_table_grants lists exactly the nine tables, SELECT only", async () => {
        const rows = await sql<{ entry: string }[]>`
          SELECT table_schema || '.' || table_name || ':' || privilege_type AS entry
          FROM information_schema.role_table_grants
          WHERE grantee = ${ROLE}
          ORDER BY 1 COLLATE "C"
        `;
        const expected = GRANTED_TABLES.map((t) => `${t}:SELECT`);
        expect(rows.map((r) => r.entry)).toEqual(expected);
        // The catalog agrees (role_table_grants only shows grants whose
        // grantor or grantee is an enabled role of the caller).
        expect(await tableAcl()).toEqual(expected);
      });

      it("no default privileges, sequence privileges or function EXECUTE grants exist for the role", async () => {
        const [defaults] = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n
          FROM pg_default_acl d, LATERAL aclexplode(d.defaclacl) a
          WHERE a.grantee = ${ROLE}::regrole OR d.defaclrole = ${ROLE}::regrole
        `;
        expect(defaults?.n).toBe(0);
        const [sequences] = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n
          FROM pg_class c, LATERAL aclexplode(c.relacl) a
          WHERE c.relkind = 'S' AND a.grantee = ${ROLE}::regrole
        `;
        expect(sequences?.n).toBe(0);
        const [functions] = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n
          FROM pg_proc p, LATERAL aclexplode(p.proacl) a
          WHERE a.grantee = ${ROLE}::regrole
        `;
        expect(functions?.n).toBe(0);
      });
    });

    // ---- R01-T6 ------------------------------------------------------------
    it("R01-T6 — with PUBLIC CONNECT still held on a scratch database, the script fails ORDERING: and creates nothing", async () => {
      await sql.unsafe(`DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
      // A fresh database keeps PostgreSQL's default PUBLIC CONNECT — the state
      // before rating-db-roles.sql's revoke.
      await sql.unsafe(`CREATE DATABASE "${SCRATCH_DB}"`);
      // The role already exists cluster-wide (beforeAll), so "creates
      // nothing" is proven by a marker Step 1 would have reset (connection
      // limit 7 -> 10) and the absence of Step 3's explicit CONNECT grant.
      await sql.unsafe(`ALTER ROLE ${ROLE} CONNECTION LIMIT 7`);
      const scratch = postgres(
        withDatabase(databaseUrl as string, SCRATCH_DB),
        { max: 1, onnotice: () => {} },
      );
      try {
        const [pub] = await scratch<{ c: boolean }[]>`
          SELECT has_database_privilege('public', current_database(), 'CONNECT') AS c
        `;
        expect(pub?.c).toBe(true);
        await expect(runSqlFile(scratch, REPORTING_ROLES_SQL)).rejects.toThrow(
          /ORDERING:/,
        );
      } finally {
        await scratch.end();
      }
      const [after] = await sql<{ rolconnlimit: number; acl: string | null }[]>`
        SELECT (SELECT rolconnlimit FROM pg_roles WHERE rolname = ${ROLE}) AS rolconnlimit,
               (SELECT datacl::text FROM pg_database WHERE datname = ${SCRATCH_DB}) AS acl
      `;
      expect(after?.rolconnlimit).toBe(7);
      expect(after?.acl ?? "").not.toContain(ROLE);

      await sql.unsafe(`DROP DATABASE "${SCRATCH_DB}"`);
      // Converge back for the cases that follow.
      await runSqlFile(sql, REPORTING_ROLES_SQL);
      expect((await roleAttributes())?.rolconnlimit).toBe(10);
    });

    // ---- R01-T7 ------------------------------------------------------------
    it("R01-T7 — a role made a member of another role makes the script fail DRIFT:", async () => {
      await sql.unsafe(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DRIFT_PROBE_ROLE}') THEN
            CREATE ROLE ${DRIFT_PROBE_ROLE} NOLOGIN;
          END IF;
        END $$;
      `);
      await sql.unsafe(`GRANT ${DRIFT_PROBE_ROLE} TO ${ROLE}`);
      try {
        await expect(runSqlFile(sql, REPORTING_ROLES_SQL)).rejects.toThrow(
          /DRIFT: reporting_runtime is a member of another role/,
        );
      } finally {
        await sql.unsafe(`REVOKE ${DRIFT_PROBE_ROLE} FROM ${ROLE}`);
        await sql.unsafe(`DROP ROLE ${DRIFT_PROBE_ROLE}`);
      }
      await expect(
        runSqlFile(sql, REPORTING_ROLES_SQL),
      ).resolves.toBeUndefined();
    });

    // ---- R01-T8 ------------------------------------------------------------
    describe("R01-T8 — idempotent", () => {
      it("running the script twice leaves identical grants", async () => {
        const before = await grantSnapshot();
        expect(before.tables).toHaveLength(GRANTED_TABLES.length);
        expect(before.schemas).toEqual([
          "billing:USAGE",
          "customer:USAGE",
          "product:USAGE",
        ]);
        await runSqlFile(sql, REPORTING_ROLES_SQL);
        await runSqlFile(sql, REPORTING_ROLES_SQL);
        expect(await grantSnapshot()).toEqual(before);
      });

      it("a re-run converges an elevated role back to least privilege", async () => {
        await sql.unsafe(
          `ALTER ROLE ${ROLE} WITH SUPERUSER CREATEROLE CREATEDB REPLICATION BYPASSRLS CONNECTION LIMIT 50`,
        );
        await sql.unsafe(
          `ALTER ROLE ${ROLE} SET default_transaction_read_only = off`,
        );
        await runSqlFile(sql, REPORTING_ROLES_SQL);
        expect(await roleAttributes()).toEqual({
          rolcanlogin: true,
          rolsuper: false,
          rolcreaterole: false,
          rolcreatedb: false,
          rolreplication: false,
          rolbypassrls: false,
          rolconnlimit: 10,
          rolconfig: ["default_transaction_read_only=on"],
        });
      });
    });
  },
);
