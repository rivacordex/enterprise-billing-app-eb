import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// ac01-spec §3.7: the scratch + V1 zero-sum test. Named for the plan's V1
// (code-standards §7.1) — every later posting test re-runs this zero-sum
// assertion (workflow rules §5). This unit ships zero application access to
// the ledger (no repositories yet — ac02+), so this test calls
// billing.pgledger_* functions/views directly via the raw postgres client,
// which is *test* code, not app code (module inv. #4 only restricts
// application code to functions/views, which this also honours — no direct
// DML on the base pgledger_* tables anywhere below).
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "billing.pgledger fork — V1 zero-sum (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');

      const { drizzle } = await import("drizzle-orm/postgres-js");
      const { migrate } = await import("drizzle-orm/postgres-js/migrator");
      await migrate(drizzle(sql), {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
    }, 30_000);

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    it("creates the billing schema, the three pgledger tables, the three views, and the create_account/create_transfer(s) functions", async () => {
      const schemas = await sql<{ schema_name: string }[]>`
        SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'billing'
      `;
      expect(schemas).toHaveLength(1);

      const tables = await sql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'billing' AND table_type = 'BASE TABLE'
      `;
      expect(tables.map((t) => t.table_name).sort()).toEqual(
        ["pgledger_accounts", "pgledger_entries", "pgledger_transfers"].sort(),
      );

      const views = await sql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.views WHERE table_schema = 'billing'
      `;
      expect(views.map((v) => v.table_name).sort()).toEqual(
        [
          "pgledger_accounts_view",
          "pgledger_entries_view",
          "pgledger_transfers_view",
        ].sort(),
      );

      const routines = await sql<{ routine_name: string }[]>`
        SELECT DISTINCT routine_name FROM information_schema.routines
        WHERE routine_schema = 'billing'
          AND routine_name IN ('pgledger_create_account', 'pgledger_create_transfer', 'pgledger_create_transfers')
      `;
      expect(routines.map((r) => r.routine_name).sort()).toEqual(
        [
          "pgledger_create_account",
          "pgledger_create_transfer",
          "pgledger_create_transfers",
        ].sort(),
      );
    });

    it("scratch scenario: two accounts, one transfer, correct signed balances and entry legs, V1 zero-sum holds", async () => {
      const [a] = await sql<{ id: string }[]>`
        SELECT id FROM billing.pgledger_create_account('scratch.a', 'MYR')
      `;
      const [b] = await sql<{ id: string }[]>`
        SELECT id FROM billing.pgledger_create_account('scratch.b', 'MYR')
      `;
      expect(a?.id).toMatch(/^pgla_/);
      expect(b?.id).toMatch(/^pgla_/);

      const [transfer] = await sql<{ id: string }[]>`
        SELECT id FROM billing.pgledger_create_transfer(${a!.id}, ${b!.id}, '100.00')
      `;
      expect(transfer?.id).toMatch(/^pglt_/);

      const accounts = await sql<{ id: string; balance: string }[]>`
        SELECT id, balance FROM billing.pgledger_accounts_view WHERE id IN (${a!.id}, ${b!.id})
      `;
      const byId = new Map(accounts.map((r) => [r.id, Number(r.balance)]));
      // pgledger's own signed convention (pgledger.sql pgledger_create_transfers):
      // the `from` account is decremented, the `to` account is incremented.
      expect(byId.get(a!.id)).toBe(-100);
      expect(byId.get(b!.id)).toBe(100);

      const entries = await sql<
        {
          account_id: string;
          amount: string;
          account_previous_balance: string;
          account_current_balance: string;
        }[]
      >`
        SELECT account_id, amount, account_previous_balance, account_current_balance
        FROM billing.pgledger_entries_view WHERE transfer_id = ${transfer!.id}
        ORDER BY amount
      `;
      expect(entries).toHaveLength(2);
      const fromLeg = entries.find((e) => e.account_id === a!.id);
      const toLeg = entries.find((e) => e.account_id === b!.id);
      expect(Number(fromLeg?.amount)).toBe(-100);
      expect(Number(fromLeg?.account_previous_balance)).toBe(0);
      expect(Number(fromLeg?.account_current_balance)).toBe(-100);
      expect(Number(toLeg?.amount)).toBe(100);
      expect(Number(toLeg?.account_previous_balance)).toBe(0);
      expect(Number(toLeg?.account_current_balance)).toBe(100);

      // V1: Σ balance = 0 per currency (plan §4 step 1).
      const [row] = await sql<{ total: string | null }[]>`
        SELECT sum(balance)::text AS total FROM billing.pgledger_accounts_view WHERE currency = 'MYR'
      `;
      expect(Number(row?.total)).toBe(0);
    });

    it("the engine rejects a cross-currency transfer with no app-layer check present", async () => {
      const [myr] = await sql<{ id: string }[]>`
        SELECT id FROM billing.pgledger_create_account('scratch.currency-myr', 'MYR')
      `;
      const [usd] = await sql<{ id: string }[]>`
        SELECT id FROM billing.pgledger_create_account('scratch.currency-usd', 'USD')
      `;

      await expect(
        sql`SELECT * FROM billing.pgledger_create_transfer(${myr!.id}, ${usd!.id}, '10.00')`,
      ).rejects.toThrow(/different currencies/i);
    });

    it("the engine rejects a zero or negative amount transfer with no app-layer check present", async () => {
      const [a] = await sql<{ id: string }[]>`
        SELECT id FROM billing.pgledger_create_account('scratch.amount-a', 'MYR')
      `;
      const [b] = await sql<{ id: string }[]>`
        SELECT id FROM billing.pgledger_create_account('scratch.amount-b', 'MYR')
      `;

      await expect(
        sql`SELECT * FROM billing.pgledger_create_transfer(${a!.id}, ${b!.id}, '0')`,
      ).rejects.toThrow();
      await expect(
        sql`SELECT * FROM billing.pgledger_create_transfer(${a!.id}, ${b!.id}, '-5.00')`,
      ).rejects.toThrow();

      // Rejected calls leave no residue — zero-sum still holds for MYR.
      const [row] = await sql<{ total: string | null }[]>`
        SELECT sum(balance)::text AS total FROM billing.pgledger_accounts_view WHERE currency = 'MYR'
      `;
      expect(Number(row?.total)).toBe(0);
    });

    it("allow_negative_balance defaults to true", async () => {
      const [account] = await sql<
        { allow_negative_balance: boolean; allow_positive_balance: boolean }[]
      >`
        SELECT allow_negative_balance, allow_positive_balance
        FROM billing.pgledger_create_account('scratch.defaults', 'MYR')
      `;
      expect(account?.allow_negative_balance).toBe(true);
      expect(account?.allow_positive_balance).toBe(true);
    });
  },
);
