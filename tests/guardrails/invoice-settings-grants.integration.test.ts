import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// bm50-spec §Design D8, guardrail 56 (grants half) — over information_schema:
// app_runtime has SELECT on bill_format, SELECT/INSERT/UPDATE on the other
// three catalog tables and NO DELETE on any; billrun_runtime has nothing on the
// four tables and lost INSERT/UPDATE on the two reserved customer_bill stamp
// columns (Inv #41). Runs the real bootstrap SQL (no hand-copied grant list).
const databaseUrl = process.env.DATABASE_URL;

const CATALOG_TABLES = [
  "bill_format",
  "bill_template_version",
  "bill_asset",
  "bill_asset_version",
];
const STAMP_COLUMNS = [
  "ref_bill_format_id",
  "ref_bill_template_version_id",
  "ref_invoice_profile_version",
  "ref_csv_template_version_id",
];

function statements(path: string): string[] {
  return readFileSync(join(process.cwd(), path), "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe.skipIf(!databaseUrl)(
  "bm50 invoice-settings grants (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;

    async function dropAll(): Promise<void> {
      for (const s of [
        "billing",
        "customer",
        "product",
        "rating",
        "core",
        "drizzle",
        "partman",
        "inventory",
        "ordering",
      ]) {
        await sql.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
      }
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 5 });
      await dropAll();
      await migrate(drizzle(sql, { schema }), {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
      // Real bootstrap, in provisioning order (kestra skipped — a separate DB,
      // irrelevant to these grants).
      for (const file of [
        "db/bootstrap/bootstrap-db-roles.sql",
        "db/bootstrap/rating-db-roles.sql",
        "db/bootstrap/billrun-db-roles.sql",
      ]) {
        for (const stmt of statements(file)) {
          await sql.unsafe(stmt);
        }
      }
    }, 180_000);

    afterAll(async () => {
      if (sql) {
        await dropAll();
        await sql.end();
      }
    }, 60_000);

    async function tablePrivs(
      grantee: string,
      table: string,
    ): Promise<string[]> {
      const rows = await sql<{ privilege_type: string }[]>`
        SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = ${grantee} AND table_schema = 'billing' AND table_name = ${table}`;
      return rows.map((r) => r.privilege_type).sort();
    }

    async function columnPrivs(
      grantee: string,
      column: string,
    ): Promise<string[]> {
      const rows = await sql<{ privilege_type: string }[]>`
        SELECT privilege_type FROM information_schema.column_privileges
        WHERE grantee = ${grantee} AND table_schema = 'billing'
          AND table_name = 'customer_bill' AND column_name = ${column}`;
      return rows.map((r) => r.privilege_type).sort();
    }

    it("app_runtime: SELECT on bill_format; SELECT/INSERT/UPDATE on the other three; no DELETE on any", async () => {
      expect(await tablePrivs("app_runtime", "bill_format")).toEqual([
        "SELECT",
      ]);
      for (const t of [
        "bill_template_version",
        "bill_asset",
        "bill_asset_version",
      ]) {
        const privs = await tablePrivs("app_runtime", t);
        expect(privs).toEqual(["INSERT", "SELECT", "UPDATE"]);
      }
      for (const t of CATALOG_TABLES) {
        expect(await tablePrivs("app_runtime", t)).not.toContain("DELETE");
      }
    });

    it("billrun_runtime: no privilege on any of the four catalog tables", async () => {
      for (const t of CATALOG_TABLES) {
        expect(await tablePrivs("billrun_runtime", t)).toEqual([]);
      }
    });

    it("billrun_runtime: no INSERT/UPDATE on the four customer_bill stamp columns", async () => {
      for (const c of STAMP_COLUMNS) {
        const privs = await columnPrivs("billrun_runtime", c);
        expect(privs).not.toContain("INSERT");
        expect(privs).not.toContain("UPDATE");
      }
    });
  },
);
