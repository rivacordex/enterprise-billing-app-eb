import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// pm70-spec I6.7 — the pm70 half of guardrail 47 (prodmgmt Inv. #64, #67;
// code-standards §6.42). The grant surface is the deliverable, so every
// assertion reads the live catalog after the real bootstrap files run, in the
// D1 provisioning order (roles -> rating-roles -> billrun-roles ->
// reporting-roles), the posture of tests/db/reporting-db-roles.integration.test.ts.
//
// - billrun_runtime / rating_runtime: SELECT on product.offering_price_v and
//   NOTHING on any pop_* subtype table or the two reference tables (the view is
//   owner-privileged, so the view grant is the whole surface).
// - app_runtime: SELECT and no INSERT/UPDATE/DELETE on the two reference tables
//   (G-N6a REVOKE, Inv. #64).
// - reporting_runtime: nothing new; its drift-guarded bootstrap still completes.
//
// DATABASE_URL must be a SUPERUSER/OWNER connection on a THROWAWAY cluster.
const databaseUrl = process.env.DATABASE_URL;

const sqlPath = (name: string) => join(process.cwd(), "db/bootstrap", name);
const BOOTSTRAP_FILES = [
  "bootstrap-db-roles.sql",
  "rating-db-roles.sql",
  "billrun-db-roles.sql",
  "reporting-db-roles.sql",
].map(sqlPath);

const VIEW = "product.offering_price_v";
const SUBTYPE_TABLES = [
  "product.pop_usage_rate",
  "product.pop_flat_fee",
  "product.pop_capacity_commitment",
  "product.pop_motivation_step",
];
const REFERENCE_TABLES = [
  "product.price_component_type",
  "product.price_component_price_type",
];
const NEW_TABLES = [
  ...SUBTYPE_TABLES,
  ...REFERENCE_TABLES,
  "product.product_spec_characteristic",
];
const PRIVILEGES = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
];

function statements(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Same semantics as the db/bootstrap/*.ts runners: statements in order,
// stopping at the first error.
async function runSqlFile(client: postgresjs.Sql, path: string): Promise<void> {
  for (const statement of statements(path)) {
    await client.unsafe(statement);
  }
}

describe.skipIf(!databaseUrl)(
  "pm70 normalized-product grants (requires a superuser DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;

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

    async function has(
      role: string,
      table: string,
      privilege: string,
    ): Promise<boolean> {
      const [row] = await sql<{ ok: boolean }[]>`
        SELECT has_table_privilege(${role}, ${table}, ${privilege}) AS ok`;
      return row?.ok === true;
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1, onnotice: () => {} });
      await dropAll(sql);
      await migrate(drizzle(sql, { schema }), {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
      // The reporting file runs last and carries the drift guard: it raises if
      // reporting_runtime holds anything outside its enumerated surface, so its
      // completing here IS the "drift guard still passes" assertion.
      for (const file of BOOTSTRAP_FILES) await runSqlFile(sql, file);
    }, 180_000);

    afterAll(async () => {
      if (sql) {
        await dropAll(sql);
        await sql.end();
      }
    }, 120_000);

    it("billrun_runtime and rating_runtime hold SELECT on product.offering_price_v", async () => {
      expect(await has("billrun_runtime", VIEW, "SELECT")).toBe(true);
      expect(await has("rating_runtime", VIEW, "SELECT")).toBe(true);
      for (const role of ["billrun_runtime", "rating_runtime"]) {
        for (const p of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
          expect(await has(role, VIEW, p)).toBe(false);
        }
      }
    });

    it("billrun_runtime and rating_runtime hold NOTHING on any pop_* or reference table (Inv. #67)", async () => {
      for (const role of ["billrun_runtime", "rating_runtime"]) {
        for (const table of [
          ...SUBTYPE_TABLES,
          ...REFERENCE_TABLES,
          "product.product_spec_characteristic",
        ]) {
          for (const p of PRIVILEGES) {
            expect(await has(role, table, p), `${role} ${p} ${table}`).toBe(
              false,
            );
          }
        }
      }
    });

    it("app_runtime has SELECT and no INSERT/UPDATE/DELETE on the two reference tables (G-N6a, Inv. #64)", async () => {
      for (const table of REFERENCE_TABLES) {
        expect(await has("app_runtime", table, "SELECT")).toBe(true);
        for (const p of ["INSERT", "UPDATE", "DELETE"]) {
          expect(await has("app_runtime", table, p), `${p} ${table}`).toBe(
            false,
          );
        }
      }
    });

    it("app_runtime keeps DML on the five child tables (the repository writes them)", async () => {
      for (const table of [
        ...SUBTYPE_TABLES,
        "product.product_spec_characteristic",
      ]) {
        for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
          expect(await has("app_runtime", table, p), `${p} ${table}`).toBe(
            true,
          );
        }
      }
    });

    it("reporting_runtime holds no privilege on the view or any new table (G-N7 not granted here)", async () => {
      for (const table of [VIEW, ...NEW_TABLES]) {
        for (const p of PRIVILEGES) {
          expect(
            await has("reporting_runtime", table, p),
            `${p} ${table}`,
          ).toBe(false);
        }
      }
    });

    it("re-running the three changed bootstraps is idempotent", async () => {
      for (const file of BOOTSTRAP_FILES.slice(0, 3)) {
        await runSqlFile(sql, file);
      }
      expect(await has("billrun_runtime", VIEW, "SELECT")).toBe(true);
      expect(await has("rating_runtime", VIEW, "SELECT")).toBe(true);
      expect(
        await has("app_runtime", "product.price_component_type", "INSERT"),
      ).toBe(false);
    });

    it("every new grant statement is enumerated — none is ON ALL TABLES or a default privilege", () => {
      for (const file of BOOTSTRAP_FILES.slice(0, 3)) {
        for (const statement of statements(file)) {
          if (!/offering_price_v|price_component_(price_)?type/.test(statement))
            continue;
          const body = statement
            .split("\n")
            .filter((l) => !l.trim().startsWith("--"))
            .join("\n");
          expect(body).not.toMatch(/ON ALL TABLES/i);
          expect(body).not.toMatch(/ALTER DEFAULT PRIVILEGES/i);
          expect(body).not.toMatch(/pop_/);
        }
      }
      expect(
        readFileSync(sqlPath("reporting-db-roles.sql"), "utf8"),
      ).not.toMatch(/offering_price_v|pop_|price_component_(price_)?type/);
    });
  },
);
