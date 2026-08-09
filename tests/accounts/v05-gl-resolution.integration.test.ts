import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// ac03-spec §3.3 — V5 GL-resolution seed test (code-standards §7.1).
// Asserts Module Inv. #10: every pgledger account resolves to exactly one
// postable GL code after seeding, and still 0 unmapped after onboarding a
// fixture FA/BAN with three ledger_binding rows (proves role rules cover new
// accounts with zero new mapping rows).
//
// Seeding is done inline via raw SQL to keep the test self-contained and
// consistent with the V01/V02 integration test pattern. The exact rows match
// the seed helpers exactly.
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "GL resolution — V5 seed health + onboarding (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let appuserId: string;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });

      // Fresh schema identical to the V01/V02 pattern.
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await migrate(drizzle(sql), {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      // Appuser required for FK columns on catalog tables that are nullable
      // in seeds (last_edited_by = NULL) — only the fixture inserts use it.
      const [user] = await sql<{ id: string }[]>`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES ('test-user-v05', 'V05 Test User', 'v05@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id
      `;
      if (!user) throw new Error("appuser insert returned no row");
      appuserId = user.id;

      // ── Seed sys pgledger accounts ───────────────────────────────────────
      for (const name of [
        "sys.cash.MYR",
        "sys.revenue.MYR",
        "sys.revenue_adj.MYR",
        "sys.write_off.MYR",
        "sys.rounding.MYR",
        "sys.tax_payable.MYR",
      ]) {
        await sql`SELECT id FROM billing.pgledger_create_account(${name}, 'MYR')`;
      }

      // ── Seed Chart of Accounts ───────────────────────────────────────────
      // Parents before children (self-referential FK).
      await sql`
        INSERT INTO billing.gl_account (gl_code, name, account_class, normal_balance, parent_gl_code, is_postable, state)
        VALUES
          ('1000', 'Current Assets',              'asset',     'debit',  NULL,   false, 'active'),
          ('2000', 'Current Liabilities',          'liability', 'credit', NULL,   false, 'active'),
          ('4000', 'Service Revenue',              'revenue',   'credit', NULL,   true,  'active'),
          ('4090', 'Revenue Adjustments',          'revenue',   'credit', NULL,   true,  'active'),
          ('6100', 'Bad Debt Expense',             'expense',   'debit',  NULL,   true,  'active'),
          ('6900', 'Rounding Differences',         'expense',   'debit',  NULL,   true,  'active'),
          ('1050', 'Cash Clearing',                'asset',     'debit',  '1000', true,  'active'),
          ('1200', 'Accounts Receivable',          'asset',     'debit',  '1000', true,  'active'),
          ('2200', 'SST Payable',                  'liability', 'credit', '2000', true,  'active'),
          ('2300', 'Unapplied Customer Receipts',  'liability', 'credit', '2000', true,  'active'),
          ('2400', 'Customer Deposits',            'liability', 'credit', '2000', true,  'active')
      `;

      // ── Seed GL mappings ─────────────────────────────────────────────────
      await sql`
        INSERT INTO billing.gl_mapping (selector_type, selector, currency, ref_gl_code)
        VALUES
          ('ledger_role',    'receivables',        NULL,  '1200'),
          ('ledger_role',    'unapplied_cash',     NULL,  '2300'),
          ('ledger_role',    'deposits',           NULL,  '2400'),
          ('system_account', 'sys.revenue.MYR',     'MYR', '4000'),
          ('system_account', 'sys.revenue_adj.MYR', 'MYR', '4090'),
          ('system_account', 'sys.write_off.MYR',   'MYR', '6100'),
          ('system_account', 'sys.rounding.MYR',    'MYR', '6900'),
          ('system_account', 'sys.tax_payable.MYR', 'MYR', '2200'),
          ('system_account', 'sys.cash.MYR',        'MYR', '1050')
      `;

      // ── Seed reason codes ────────────────────────────────────────────────
      await sql`
        INSERT INTO billing.reason_code (reason_code, doc_type, posting_nature, auto_post_limit, state)
        VALUES
          ('CUST_PAYMENT',     'PAY', 'cash',             '100000.00', 'active'),
          ('ADVANCE_PAYMENT',  'PAY', 'cash',             '100000.00', 'active'),
          ('PAYMENT_REFUND',   'PAY', 'cash',                  '0.00', 'active'),
          ('SEC_DEPOSIT',      'DEP', 'deposit_movement',  '50000.00', 'active'),
          ('DEP_REVERSE',      'DEP', 'deposit_movement',       '0.00', 'active'),
          ('DEP_REFUND',       'DEP', 'deposit_movement',       '0.00', 'active'),
          ('GOODWILL_CREDIT',  'CRN', 'revenue_adj',        '1000.00', 'active'),
          ('MANUAL_CHARGE',   'DBN', 'revenue',            '10000.00', 'active'),
          ('BAD_DEBT_WRITEOFF','ADJ', 'write_off',              '0.00', 'active'),
          ('ROUNDING_ADJ',     'ADJ', 'rounding',              '10.00', 'active')
      `;

      // ── Seed bill cycles ─────────────────────────────────────────────────
      await sql`
        INSERT INTO billing.bill_cycle (name, frequency, cycle_day, payment_due_days, state)
        VALUES
          ('Monthly – Day 1',  'monthly', 1,  30, 'active'),
          ('Monthly – Day 15', 'monthly', 15, 30, 'active')
      `;

      // ── Seed wizard defaults ─────────────────────────────────────────────
      const [defaultCycle] = await sql<{ id: string }[]>`
        SELECT bill_cycle_id AS id FROM billing.bill_cycle WHERE name = 'Monthly – Day 1' LIMIT 1
      `;
      if (!defaultCycle)
        throw new Error("default bill cycle not found after seed");

      await sql`
        INSERT INTO core.system_config (config_group, config_version, config_key, config_value, description, is_secret, status)
        VALUES
          ('accounts', 1, 'ACCOUNTS_DEFAULT_BILL_CYCLE',  ${defaultCycle.id},
            'Default bill cycle assigned to new billing accounts in the onboarding wizard.',
            false, 'ACTIVE'),
          ('accounts', 1, 'ACCOUNTS_DEFAULT_CURRENCY',    'MYR',
            'Default currency for new financial accounts (Q12 — single MYR family this phase).',
            false, 'ACTIVE'),
          ('accounts', 1, 'ACCOUNTS_DEFAULT_CREDIT_LIMIT', NULL,
            'Default credit limit pre-fill for new financial accounts; null = no pre-fill.',
            false, 'ACTIVE')
      `;
    }, 60_000);

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    // ── V5a: 0 unmapped after seeding ──────────────────────────────────────
    it("V5a — gl_resolution_view has 0 unmapped accounts immediately after seeding", async () => {
      const [row] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM billing.gl_resolution_view
        WHERE gl_code IS NULL
      `;
      expect(Number(row?.count)).toBe(0);
    });

    it("V5a — all six sys.* MYR accounts are present and individually resolved", async () => {
      const rows = await sql<{ name: string; gl_code: string | null }[]>`
        SELECT pav.name, grv.gl_code
        FROM billing.pgledger_accounts_view pav
        JOIN billing.gl_resolution_view grv ON grv.pgledger_account_id = pav.id
        WHERE pav.name LIKE 'sys.%.MYR'
        ORDER BY pav.name
      `;
      expect(rows).toHaveLength(6);
      for (const row of rows) {
        expect(row.gl_code).not.toBeNull();
      }
    });

    it("V5a — resolution is unambiguous: every resolved gl_code is postable", async () => {
      const [row] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM billing.gl_resolution_view grv
        JOIN billing.gl_account ga ON ga.gl_code = grv.gl_code
        WHERE NOT ga.is_postable
      `;
      expect(Number(row?.count)).toBe(0);
    });

    // ── V5b: 0 unmapped after onboarding a fixture BAN/FA ─────────────────
    it("V5b — 0 unmapped after onboarding a fixture FA/BAN with three ledger_binding rows", async () => {
      // Create the three pgledger accounts for the fixture.
      const [pglaReceivables] = await sql<{ id: string }[]>`
        SELECT id FROM billing.pgledger_create_account('ban.v05fixture.receivables', 'MYR')
      `;
      const [pglaUnapplied] = await sql<{ id: string }[]>`
        SELECT id FROM billing.pgledger_create_account('fa.v05fixture.unapplied_cash', 'MYR')
      `;
      const [pglaDeposits] = await sql<{ id: string }[]>`
        SELECT id FROM billing.pgledger_create_account('fa.v05fixture.deposits', 'MYR')
      `;
      if (!pglaReceivables || !pglaUnapplied || !pglaDeposits) {
        throw new Error("fixture pgledger account creation failed");
      }

      // Customer fixture (organization + party_role) required for FA/BAN FKs.
      const [org] = await sql<{ id: string }[]>`
        INSERT INTO customer.organization (name, organization_type, last_modified_by)
        VALUES ('V05 Fixture Org', 'COMPANY', ${appuserId})
        RETURNING organization_id AS id
      `;
      if (!org) throw new Error("organization insert failed");
      const [pr] = await sql<{ id: string }[]>`
        INSERT INTO customer.party_role (engaged_party, status, last_modified_by)
        VALUES (${org.id}, 'ACTIVE', ${appuserId})
        RETURNING party_role_id AS id
      `;
      if (!pr) throw new Error("party_role insert failed");

      // Bill cycle already seeded — look up BCY000001 by name.
      const [cycle] = await sql<{ id: string }[]>`
        SELECT bill_cycle_id AS id FROM billing.bill_cycle WHERE name = 'Monthly – Day 1' LIMIT 1
      `;
      if (!cycle) throw new Error("default bill cycle not found");

      // Insert FA + BAN.
      const [fa] = await sql<{ id: string }[]>`
        INSERT INTO billing.financial_account (name, ref_party_role_id, currency, last_edited_by)
        VALUES ('V05 FA', ${pr.id}, 'MYR', ${appuserId})
        RETURNING financial_account_id AS id
      `;
      if (!fa) throw new Error("financial_account insert failed");

      const [ban] = await sql<{ id: string }[]>`
        INSERT INTO billing.billing_account
          (name, ref_party_role_id, ref_financial_account_id, currency, ref_bill_cycle_id, last_edited_by)
        VALUES ('V05 BAN', ${pr.id}, ${fa.id}, 'MYR', ${cycle.id}, ${appuserId})
        RETURNING billing_account_id AS id
      `;
      if (!ban) throw new Error("billing_account insert failed");

      // Three ledger_binding rows (Module Inv. #9).
      await sql`
        INSERT INTO billing.ledger_binding (owner_type, owner_id, ledger_role, pgledger_account_id, last_edited_by)
        VALUES
          ('billing_account',  ${ban.id}, 'receivables',   ${pglaReceivables.id}, ${appuserId}),
          ('financial_account',${fa.id},  'unapplied_cash',${pglaUnapplied.id},   ${appuserId}),
          ('financial_account',${fa.id},  'deposits',      ${pglaDeposits.id},    ${appuserId})
      `;

      // V5 headline: still 0 unmapped — the role rules cover the new accounts
      // with no new gl_mapping rows (spec §2.1 / Module Inv. #10).
      const [row] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM billing.gl_resolution_view
        WHERE gl_code IS NULL
      `;
      expect(Number(row?.count)).toBe(0);

      // V1 zero-sum: adding accounts without transfers changes nothing.
      const [sum] = await sql<{ total: string | null }[]>`
        SELECT sum(balance)::text AS total
        FROM billing.pgledger_accounts_view
        WHERE currency = 'MYR'
      `;
      expect(Number(sum?.total ?? "0")).toBe(0);
    });

    // ── Catalog integrity ──────────────────────────────────────────────────
    it("catalog — ten reason codes exist with exact auto_post_limits", async () => {
      const rows = await sql<
        { reason_code: string; auto_post_limit: string }[]
      >`
        SELECT reason_code, auto_post_limit::text
        FROM billing.reason_code
        ORDER BY reason_code
      `;
      expect(rows).toHaveLength(10);

      const byCode = new Map(
        rows.map((r) => [r.reason_code, r.auto_post_limit]),
      );

      // Four always-four-eyes codes (limit 0).
      for (const code of [
        "PAYMENT_REFUND",
        "DEP_REVERSE",
        "DEP_REFUND",
        "BAD_DEBT_WRITEOFF",
      ]) {
        expect(byCode.get(code), `${code} limit`).toBe("0.00");
      }

      // Spot-check non-zero limits.
      expect(byCode.get("CUST_PAYMENT")).toBe("100000.00");
      expect(byCode.get("ADVANCE_PAYMENT")).toBe("100000.00");
      expect(byCode.get("SEC_DEPOSIT")).toBe("50000.00");
      expect(byCode.get("GOODWILL_CREDIT")).toBe("1000.00");
      expect(byCode.get("MANUAL_CHARGE")).toBe("10000.00");
      expect(byCode.get("ROUNDING_ADJ")).toBe("10.00");
    });

    it("catalog — 11 CoA codes with correct is_postable and normal_balance", async () => {
      const rows = await sql<
        { gl_code: string; is_postable: boolean; normal_balance: string }[]
      >`
        SELECT gl_code, is_postable, normal_balance
        FROM billing.gl_account
        ORDER BY gl_code
      `;
      expect(rows).toHaveLength(11);

      const byCode = new Map(rows.map((r) => [r.gl_code, r]));

      // Summary nodes must not be postable.
      expect(byCode.get("1000")?.is_postable).toBe(false);
      expect(byCode.get("2000")?.is_postable).toBe(false);

      // All leaves must be postable.
      for (const code of [
        "1050",
        "1200",
        "2200",
        "2300",
        "2400",
        "4000",
        "4090",
        "6100",
        "6900",
      ]) {
        expect(byCode.get(code)?.is_postable, `${code} is_postable`).toBe(true);
      }

      // normal_balance spot-checks.
      expect(byCode.get("1200")?.normal_balance).toBe("debit"); // A/R = asset
      expect(byCode.get("2300")?.normal_balance).toBe("credit"); // unapplied = liability
      expect(byCode.get("4000")?.normal_balance).toBe("credit"); // revenue
      expect(byCode.get("6100")?.normal_balance).toBe("debit"); // expense
    });

    it("catalog — two bill cycles and all three wizard config rows exist", async () => {
      const cycles = await sql<{ name: string }[]>`
        SELECT name FROM billing.bill_cycle ORDER BY cycle_day
      `;
      expect(cycles).toHaveLength(2);
      expect(cycles[0]?.name).toBe("Monthly – Day 1");
      expect(cycles[1]?.name).toBe("Monthly – Day 15");

      const configs = await sql<
        { config_key: string; config_value: string | null }[]
      >`
        SELECT config_key, config_value
        FROM core.system_config
        WHERE config_group = 'accounts'
        ORDER BY config_key
      `;
      expect(configs).toHaveLength(3);

      const byKey = new Map(configs.map((c) => [c.config_key, c.config_value]));
      expect(byKey.has("ACCOUNTS_DEFAULT_BILL_CYCLE")).toBe(true);
      expect(byKey.get("ACCOUNTS_DEFAULT_BILL_CYCLE")).toMatch(/^BCY\d{8}$/);
      expect(byKey.get("ACCOUNTS_DEFAULT_CURRENCY")).toBe("MYR");
      expect(byKey.has("ACCOUNTS_DEFAULT_CREDIT_LIMIT")).toBe(true);
      expect(byKey.get("ACCOUNTS_DEFAULT_CREDIT_LIMIT")).toBeNull();
    });

    // ── Idempotency ────────────────────────────────────────────────────────
    it("idempotency — re-inserting seed rows with ON CONFLICT DO NOTHING leaves counts unchanged", async () => {
      // Re-run all catalog inserts idempotently.
      await sql`
        INSERT INTO billing.gl_account (gl_code, name, account_class, normal_balance, parent_gl_code, is_postable, state)
        VALUES
          ('1000', 'Current Assets',             'asset',     'debit',  NULL,   false, 'active'),
          ('2000', 'Current Liabilities',         'liability', 'credit', NULL,   false, 'active'),
          ('4000', 'Service Revenue',             'revenue',   'credit', NULL,   true,  'active'),
          ('4090', 'Revenue Adjustments',         'revenue',   'credit', NULL,   true,  'active'),
          ('6100', 'Bad Debt Expense',            'expense',   'debit',  NULL,   true,  'active'),
          ('6900', 'Rounding Differences',        'expense',   'debit',  NULL,   true,  'active'),
          ('1050', 'Cash Clearing',               'asset',     'debit',  '1000', true,  'active'),
          ('1200', 'Accounts Receivable',         'asset',     'debit',  '1000', true,  'active'),
          ('2200', 'SST Payable',                 'liability', 'credit', '2000', true,  'active'),
          ('2300', 'Unapplied Customer Receipts', 'liability', 'credit', '2000', true,  'active'),
          ('2400', 'Customer Deposits',           'liability', 'credit', '2000', true,  'active')
        ON CONFLICT (gl_code) DO NOTHING
      `;
      await sql`
        INSERT INTO billing.reason_code (reason_code, doc_type, posting_nature, auto_post_limit, state)
        VALUES
          ('CUST_PAYMENT',     'PAY', 'cash',             '100000.00', 'active'),
          ('ADVANCE_PAYMENT',  'PAY', 'cash',             '100000.00', 'active'),
          ('PAYMENT_REFUND',   'PAY', 'cash',                  '0.00', 'active'),
          ('SEC_DEPOSIT',      'DEP', 'deposit_movement',  '50000.00', 'active'),
          ('DEP_REVERSE',      'DEP', 'deposit_movement',       '0.00', 'active'),
          ('DEP_REFUND',       'DEP', 'deposit_movement',       '0.00', 'active'),
          ('GOODWILL_CREDIT',  'CRN', 'revenue_adj',        '1000.00', 'active'),
          ('MANUAL_CHARGE',   'DBN', 'revenue',            '10000.00', 'active'),
          ('BAD_DEBT_WRITEOFF','ADJ', 'write_off',              '0.00', 'active'),
          ('ROUNDING_ADJ',     'ADJ', 'rounding',              '10.00', 'active')
        ON CONFLICT (reason_code) DO NOTHING
      `;
      await sql`
        INSERT INTO billing.bill_cycle (name, frequency, cycle_day, payment_due_days, state)
        VALUES
          ('Monthly – Day 1',  'monthly', 1,  30, 'active'),
          ('Monthly – Day 15', 'monthly', 15, 30, 'active')
        ON CONFLICT (name) DO NOTHING
      `;

      const [glCount] = await sql<
        { n: string }[]
      >`SELECT count(*)::text AS n FROM billing.gl_account`;
      const [rcCount] = await sql<
        { n: string }[]
      >`SELECT count(*)::text AS n FROM billing.reason_code`;
      const [bcCount] = await sql<
        { n: string }[]
      >`SELECT count(*)::text AS n FROM billing.bill_cycle`;
      const [gmCount] = await sql<
        { n: string }[]
      >`SELECT count(*)::text AS n FROM billing.gl_mapping`;
      const [cfCount] = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM core.system_config WHERE config_group = 'accounts'
      `;

      expect(Number(glCount?.n)).toBe(11);
      expect(Number(rcCount?.n)).toBe(10);
      expect(Number(bcCount?.n)).toBe(2);
      expect(Number(gmCount?.n)).toBe(9);
      expect(Number(cfCount?.n)).toBe(3);
    });

    it("idempotency — sys accounts count stays at 6 after seed (pgledger has no name-UNIQUE constraint; seed pre-checks prevent duplicates)", async () => {
      // pgledger_create_account has no UNIQUE constraint on name — the seed
      // script's pre-check (`pgledger_accounts_view WHERE name = ?`) is what
      // prevents duplicates on re-run. Here we only verify the seeded count.
      const [row] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM billing.pgledger_accounts_view
        WHERE name LIKE 'sys.%.MYR'
      `;
      expect(Number(row?.count)).toBe(6);
    });
  },
);
