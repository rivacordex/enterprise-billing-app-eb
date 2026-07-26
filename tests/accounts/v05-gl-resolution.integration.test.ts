import { execFileSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

const databaseUrl = process.env.DATABASE_URL;

// Runs the real `db:seed-accounts` script as a child process — never
// imported directly (db/seeds/accounts/seed-accounts.ts is a standalone
// script, matching every other seed script's convention, see
// tests/db/customer-seed.integration.test.ts). Requires
// `NODE_OPTIONS=--conditions=react-server` because `lib/config.ts` imports
// `server-only`.
function runSeedAccounts(): void {
  execFileSync(
    process.execPath,
    ["--import", "tsx", "db/seeds/accounts/seed-accounts.ts"],
    {
      env: { ...process.env, NODE_OPTIONS: "--conditions=react-server" },
      stdio: "pipe",
    },
  );
}

// V5 (ac03-spec §3.3, module Inv. #10): after `db:seed-accounts` on a fresh
// ac02 database, `gl_resolution_view` has zero unmapped accounts — both for
// the six seeded `sys.*` accounts and for a freshly-onboarded fixture FA/BAN
// with real bindings, proving the *role* mapping rules (not per-account
// rows) cover accounts that don't exist yet.
describe.skipIf(!databaseUrl)(
  "ac03 seed set + GL health check (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let appuserId: string;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await migrate(drizzle(sql), {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      const [user] = await sql<{ id: string }[]>`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES ('test-user-ac03', 'Test User', 'test-user-ac03@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id
      `;
      if (!user) throw new Error("Test appuser insert returned no row.");
      appuserId = user.id;

      runSeedAccounts();
    }, 60_000);

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    async function unmappedCount(): Promise<number> {
      const [row] = await sql<{ unmapped: number }[]>`
        SELECT count(*)::int AS unmapped
        FROM billing.gl_resolution_view
        WHERE gl_code IS NULL
      `;
      return row?.unmapped ?? -1;
    }

    test("six sys.* MYR pgledger accounts exist, no sys.deposit_movement, and none has a ledger_binding row", async () => {
      const sysAccounts = await sql<{ name: string }[]>`
        SELECT name FROM billing.pgledger_accounts_view
        WHERE name LIKE 'sys.%' ORDER BY name
      `;
      expect(sysAccounts.map((r) => r.name).sort()).toEqual(
        [
          "sys.cash.MYR",
          "sys.revenue.MYR",
          "sys.revenue_adj.MYR",
          "sys.write_off.MYR",
          "sys.rounding.MYR",
          "sys.tax_payable.MYR",
        ].sort(),
      );
      expect(
        sysAccounts.some((r) => r.name === "sys.deposit_movement.MYR"),
      ).toBe(false);

      const [bindingRow] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM billing.ledger_binding lb
        JOIN billing.pgledger_accounts_view pav ON pav.id = lb.pgledger_account_id
        WHERE pav.name LIKE 'sys.%'
      `;
      expect(bindingRow?.count).toBe(0);
    });

    test("0 unmapped accounts in the seeded state", async () => {
      expect(await unmappedCount()).toBe(0);
    });

    test("0 unmapped accounts after onboarding a fixture FA/BAN with its three ledger_binding rows", async () => {
      const [org] = await sql<{ id: string }[]>`
        INSERT INTO customer.organization (name, organization_type, last_modified_by)
        VALUES ('V5 Fixture Org', 'COMPANY', ${appuserId})
        RETURNING organization_id AS id
      `;
      if (!org) throw new Error("Organization insert returned no row.");

      const [partyRole] = await sql<{ id: string }[]>`
        INSERT INTO customer.party_role (engaged_party, status, last_modified_by)
        VALUES (${org.id}, 'ACTIVE', ${appuserId})
        RETURNING party_role_id AS id
      `;
      if (!partyRole) throw new Error("Party role insert returned no row.");

      const [billCycle] = await sql<{ id: string }[]>`
        SELECT bill_cycle_id AS id FROM billing.bill_cycle LIMIT 1
      `;
      if (!billCycle) throw new Error("No seeded bill cycle found.");

      const [fa] = await sql<{ id: string }[]>`
        INSERT INTO billing.financial_account (name, ref_party_role_id, currency, last_edited_by)
        VALUES ('V5 Fixture FA', ${partyRole.id}, 'MYR', ${appuserId})
        RETURNING financial_account_id AS id
      `;
      if (!fa) throw new Error("Financial account insert returned no row.");

      const [ban] = await sql<{ id: string }[]>`
        INSERT INTO billing.billing_account
          (name, ref_party_role_id, ref_financial_account_id, currency, ref_bill_cycle_id, last_edited_by)
        VALUES ('V5 Fixture BAN', ${partyRole.id}, ${fa.id}, 'MYR', ${billCycle.id}, ${appuserId})
        RETURNING billing_account_id AS id
      `;
      if (!ban) throw new Error("Billing account insert returned no row.");

      const [receivablesAccount] = await sql<{ id: string }[]>`
        SELECT id FROM billing.pgledger_create_account(${`ban.${ban.id}.receivables`}, 'MYR')
      `;
      const [unappliedCashAccount] = await sql<{ id: string }[]>`
        SELECT id FROM billing.pgledger_create_account(${`fa.${fa.id}.unapplied_cash`}, 'MYR')
      `;
      const [depositsAccount] = await sql<{ id: string }[]>`
        SELECT id FROM billing.pgledger_create_account(${`fa.${fa.id}.deposits`}, 'MYR')
      `;
      if (!receivablesAccount || !unappliedCashAccount || !depositsAccount) {
        throw new Error("Fixture pgledger_create_account calls failed.");
      }

      await sql`
        INSERT INTO billing.ledger_binding (owner_type, owner_id, ledger_role, pgledger_account_id, last_edited_by)
        VALUES ('billing_account', ${ban.id}, 'receivables', ${receivablesAccount.id}, ${appuserId})
      `;
      await sql`
        INSERT INTO billing.ledger_binding (owner_type, owner_id, ledger_role, pgledger_account_id, last_edited_by)
        VALUES ('financial_account', ${fa.id}, 'unapplied_cash', ${unappliedCashAccount.id}, ${appuserId})
      `;
      await sql`
        INSERT INTO billing.ledger_binding (owner_type, owner_id, ledger_role, pgledger_account_id, last_edited_by)
        VALUES ('financial_account', ${fa.id}, 'deposits', ${depositsAccount.id}, ${appuserId})
      `;

      expect(await unmappedCount()).toBe(0);
    });

    test("resolution is unambiguous: every resolved account maps to exactly one is_postable code", async () => {
      const rows = await sql<
        { pgledger_account_id: string; gl_code: string; is_postable: boolean }[]
      >`
        SELECT gr.pgledger_account_id, gr.gl_code, ga.is_postable
        FROM billing.gl_resolution_view gr
        JOIN billing.gl_account ga ON ga.gl_code = gr.gl_code
        WHERE gr.gl_code IS NOT NULL
      `;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.is_postable === true)).toBe(true);

      const distinctAccountIds = new Set(
        rows.map((r) => r.pgledger_account_id),
      );
      expect(distinctAccountIds.size).toBe(rows.length);
    });

    test("catalog integrity: ten reason codes with exact auto_post_limits", async () => {
      const rows = await sql<
        { reason_code: string; auto_post_limit: string; state: string }[]
      >`
        SELECT reason_code, auto_post_limit, state FROM billing.reason_code ORDER BY reason_code
      `;
      expect(rows).toHaveLength(10);
      expect(rows.every((r) => r.state === "active")).toBe(true);

      const byCode = new Map(
        rows.map((r) => [r.reason_code, r.auto_post_limit]),
      );
      expect(byCode.get("CUST_PAYMENT")).toBe("100000.00");
      expect(byCode.get("ADVANCE_PAYMENT")).toBe("100000.00");
      expect(byCode.get("PAYMENT_REFUND")).toBe("0.00");
      expect(byCode.get("SEC_DEPOSIT")).toBe("50000.00");
      expect(byCode.get("DEP_REVERSE")).toBe("0.00");
      expect(byCode.get("DEP_REFUND")).toBe("0.00");
      expect(byCode.get("GOODWILL_CREDIT")).toBe("1000.00");
      expect(byCode.get("MANUAL_CHARGE")).toBe("10000.00");
      expect(byCode.get("BAD_DEBT_WRITEOFF")).toBe("0.00");
      expect(byCode.get("ROUNDING_ADJ")).toBe("10.00");
    });

    test("catalog integrity: two bill cycles plus ACCOUNTS_DEFAULT_BILL_CYCLE/ACCOUNTS_DEFAULT_CURRENCY config", async () => {
      const cycles = await sql<{ name: string; state: string }[]>`
        SELECT name, state FROM billing.bill_cycle ORDER BY name
      `;
      expect(cycles).toHaveLength(2);
      expect(cycles.every((c) => c.state === "active")).toBe(true);

      const [defaultCycle] = await sql<{ id: string }[]>`
        SELECT bill_cycle_id AS id FROM billing.bill_cycle WHERE name = ${"Monthly – Day 1"}
      `;
      if (!defaultCycle) throw new Error("Default bill cycle not found.");

      const [cycleConfig] = await sql<{ config_value: string | null }[]>`
        SELECT config_value FROM core.system_config
        WHERE config_group = 'accounts' AND config_key = 'ACCOUNTS_DEFAULT_BILL_CYCLE'
      `;
      expect(cycleConfig?.config_value).toBe(defaultCycle.id);

      const [currencyConfig] = await sql<{ config_value: string | null }[]>`
        SELECT config_value FROM core.system_config
        WHERE config_group = 'accounts' AND config_key = 'ACCOUNTS_DEFAULT_CURRENCY'
      `;
      expect(currencyConfig?.config_value).toBe("MYR");

      const [creditLimitConfig] = await sql<{ config_value: string | null }[]>`
        SELECT config_value FROM core.system_config
        WHERE config_group = 'accounts' AND config_key = 'ACCOUNTS_DEFAULT_CREDIT_LIMIT'
      `;
      expect(creditLimitConfig?.config_value).toBeNull();
    });

    test("catalog integrity: eleven CoA codes with correct is_postable/normal_balance", async () => {
      const rows = await sql<
        { gl_code: string; is_postable: boolean; normal_balance: string }[]
      >`
        SELECT gl_code, is_postable, normal_balance FROM billing.gl_account ORDER BY gl_code
      `;
      expect(rows).toHaveLength(11);

      const byCode = new Map(rows.map((r) => [r.gl_code, r]));
      expect(byCode.get("1000")).toMatchObject({
        is_postable: false,
        normal_balance: "debit",
      });
      expect(byCode.get("2000")).toMatchObject({
        is_postable: false,
        normal_balance: "credit",
      });
      for (const code of ["1050", "1200"]) {
        expect(byCode.get(code)).toMatchObject({
          is_postable: true,
          normal_balance: "debit",
        });
      }
      for (const code of ["2200", "2300", "2400"]) {
        expect(byCode.get(code)).toMatchObject({
          is_postable: true,
          normal_balance: "credit",
        });
      }
      for (const code of ["4000", "4090"]) {
        expect(byCode.get(code)).toMatchObject({
          is_postable: true,
          normal_balance: "credit",
        });
      }
      for (const code of ["6100", "6900"]) {
        expect(byCode.get(code)).toMatchObject({
          is_postable: true,
          normal_balance: "debit",
        });
      }
    });

    test("catalog integrity: nine GL mappings, all targeting is_postable codes", async () => {
      const rows = await sql<
        { selector_type: string; selector: string; ref_gl_code: string }[]
      >`
        SELECT gm.selector_type, gm.selector, gm.ref_gl_code
        FROM billing.gl_mapping gm
        JOIN billing.gl_account ga ON ga.gl_code = gm.ref_gl_code
        WHERE ga.is_postable = true
      `;
      expect(rows).toHaveLength(9);
    });

    test("re-running db:seed-accounts is idempotent (no duplicate sys/catalog/config rows)", async () => {
      runSeedAccounts();

      const [sysCount] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM billing.pgledger_accounts_view WHERE name LIKE 'sys.%'
      `;
      expect(sysCount?.count).toBe(6);

      const [glAccountCount] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM billing.gl_account
      `;
      expect(glAccountCount?.count).toBe(11);

      const [glMappingCount] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM billing.gl_mapping
      `;
      expect(glMappingCount?.count).toBe(9);

      const [reasonCodeCount] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM billing.reason_code
      `;
      expect(reasonCodeCount?.count).toBe(10);

      const [billCycleCount] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM billing.bill_cycle
      `;
      expect(billCycleCount?.count).toBe(2);

      const [configCount] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM core.system_config WHERE config_group = 'accounts'
      `;
      expect(configCount?.count).toBe(3);

      expect(await unmappedCount()).toBe(0);
    }, 30_000);
  },
);
