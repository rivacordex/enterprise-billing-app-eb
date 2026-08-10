import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { db } from "@/db/client";
import { onboardCustomerAccounts } from "@/services/accounts/onboard-customer-accounts";
import { raiseDebitNote } from "@/services/accounts/raise-debit-note";
import { approveDocument } from "@/services/accounts/document-state-machine";
import {
  getPeriodSummary,
  getCodeDrilldown,
} from "@/services/accounts/gl-journal";

// ac13-spec §3.5 — V6: journal balance guardrail.
// Reproduces the §2 July scenario: onboard FA/BAN, raise a DBN MANUAL_CHARGE
// of 16,000 net + 200 tax (needs MANAGER approval, 16,000 > 10,000 limit),
// assert gl_journal_view totals 16,200 / 16,200; per-GL-code totals reconcile
// to raw pgledger_entries_view sums; a deliberately imbalanced fixture (unmapped
// account) flips the total row to broken; drill-down of GL 1200 lists the two
// contributing A/R entries. V1 zero-sum held throughout.
const databaseUrl = process.env.DATABASE_URL;
const EVENT_AT_JULY = new Date("2026-07-15T00:00:00.000Z");
const PERIOD_JULY = "2026-07";

describe.skipIf(!databaseUrl)(
  "V6 — journal balance (ac13-spec §3.5, requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let creatorId: string;
    let managerId: string;
    let financialAccountId: string;
    let billingAccountId: string;
    let dbnDocumentId: string;

    async function zeroSum(): Promise<number> {
      const [row] = await sql<{ total: string | null }[]>`
        SELECT sum(balance)::text AS total FROM billing.pgledger_accounts_view
      `;
      return Number(row?.total ?? "0");
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);

      // Two-connection pattern: migrate() poisons its own connection's
      // type-OID cache (ledger-explorer.integration.test.ts §beforeAll note).
      const migrateSql = postgres(databaseUrl as string, { max: 1 });
      await migrateSql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await migrateSql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await migrateSql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await migrateSql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await migrateSql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await migrate(drizzle(migrateSql), {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
      await migrateSql.end();

      sql = postgres(databaseUrl as string, { max: 1 });

      // ── Users ─────────────────────────────────────────────────────────────
      const [creator] = await sql<{ id: string }[]>`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES ('test-user-v06-creator', 'V06 Creator', 'v06-creator@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id
      `;
      creatorId = creator!.id;

      const [manager] = await sql<{ id: string }[]>`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES ('test-user-v06-manager', 'V06 Manager', 'v06-manager@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id
      `;
      managerId = manager!.id;

      // ── Sys pgledger accounts ────────────────────────────────────────────
      for (const name of [
        "sys.cash.MYR",
        "sys.revenue.MYR",
        "sys.tax_payable.MYR",
      ]) {
        await sql`SELECT id FROM billing.pgledger_create_account(${name}, 'MYR')`;
      }

      // ── Chart of Accounts (covers all ledger_roles + sys accounts needed) ─
      await sql`
        INSERT INTO billing.gl_account (gl_code, name, account_class, normal_balance, parent_gl_code, is_postable, state)
        VALUES
          ('1000', 'Current Assets',             'asset',     'debit',  NULL,   false, 'active'),
          ('2000', 'Current Liabilities',         'liability', 'credit', NULL,   false, 'active'),
          ('1050', 'Cash Clearing',               'asset',     'debit',  '1000', true,  'active'),
          ('1200', 'Accounts Receivable',         'asset',     'debit',  '1000', true,  'active'),
          ('2200', 'SST Payable',                 'liability', 'credit', '2000', true,  'active'),
          ('2300', 'Unapplied Customer Receipts', 'liability', 'credit', '2000', true,  'active'),
          ('2400', 'Customer Deposits',           'liability', 'credit', '2000', true,  'active'),
          ('4000', 'Service Revenue',             'revenue',   'credit', NULL,   true,  'active')
      `;

      // ── GL mappings ───────────────────────────────────────────────────────
      await sql`
        INSERT INTO billing.gl_mapping (selector_type, selector, currency, ref_gl_code)
        VALUES
          ('ledger_role',    'receivables',         NULL,  '1200'),
          ('ledger_role',    'unapplied_cash',       NULL,  '2300'),
          ('ledger_role',    'deposits',             NULL,  '2400'),
          ('system_account', 'sys.cash.MYR',         'MYR', '1050'),
          ('system_account', 'sys.revenue.MYR',      'MYR', '4000'),
          ('system_account', 'sys.tax_payable.MYR',  'MYR', '2200')
      `;

      // ── Reason code + bill cycle ──────────────────────────────────────────
      await sql`
        INSERT INTO billing.reason_code (reason_code, doc_type, posting_nature, auto_post_limit, state)
        VALUES ('MANUAL_CHARGE', 'DBN', 'revenue', '10000.00', 'active')
      `;

      const [cycle] = await sql<{ id: string }[]>`
        INSERT INTO billing.bill_cycle (name, frequency, cycle_day, payment_due_days, state)
        VALUES ('V06 Monthly', 'monthly', 1, 30, 'active')
        RETURNING bill_cycle_id AS id
      `;

      // ── Customer + onboarding ─────────────────────────────────────────────
      const [org] = await sql<{ id: string }[]>`
        INSERT INTO customer.organization (name, organization_type, last_modified_by)
        VALUES ('V06 Test Corp', 'COMPANY', ${creatorId})
        RETURNING organization_id AS id
      `;
      const [pr] = await sql<{ id: string; ts: Date }[]>`
        INSERT INTO customer.party_role (engaged_party, status, last_modified_by)
        VALUES (${org!.id}, 'INITIALIZED', ${creatorId})
        RETURNING party_role_id AS id, last_modified_datetime AS ts
      `;

      const onboarded = await onboardCustomerAccounts(
        {
          partyRoleId: pr!.id,
          billCycleId: cycle!.id,
          currency: "MYR",
          statusReason: "V06 journal balance test",
          lastModifiedDatetime: pr!.ts,
        },
        creatorId,
      );
      if (!onboarded.ok)
        throw new Error(`onboarding failed: ${onboarded.code}`);
      financialAccountId = onboarded.value.financialAccountId;
      billingAccountId = onboarded.value.billingAccountId;

      // ── DBN MANUAL_CHARGE 16,000 net + 200 tax (> 10,000 limit → approval) ─
      const raised = await raiseDebitNote(
        {
          financialAccountId,
          billingAccountId,
          netAmount: "16000.00",
          taxAmount: "200.00",
          eventAt: EVENT_AT_JULY,
          entryDate: EVENT_AT_JULY,
          referenceInfo: "V06 July DBN",
        },
        creatorId,
      );
      if (!raised.ok) throw new Error(`raiseDebitNote failed: ${raised.code}`);
      expect(raised.value.state).toBe("pending_approval");
      dbnDocumentId = raised.value.documentId;

      const approved = await db.transaction((tx) =>
        approveDocument(tx, dbnDocumentId, managerId),
      );
      if (!approved.ok)
        throw new Error(`approveDocument failed: ${approved.code}`);
      expect(approved.value.state).toBe("posted");

      // V1 zero-sum must hold after posting
      expect(await zeroSum()).toBe(0);
    }, 60_000);

    afterAll(async () => {
      // Guard: sql is only assigned after assertTestDatabaseUrl + migrate
      // succeed. If beforeAll throws before that point (wrong DATABASE_URL,
      // migration failure), sql is uninitialized and we must not attempt cleanup
      // — the original error should remain the reported failure.
      if (!sql) return;
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    // ── V6a: Σ debit = Σ credit = 16,200 ────────────────────────────────────
    it("V6a — gl_journal_view July totals Σ debit = Σ credit = 16,200 (balanced, spec §2)", async () => {
      const result = await getPeriodSummary(PERIOD_JULY, "movement", "gl_code");
      expect(result.totals.balanced).toBe(true);
      expect(Number(result.totals.totalDebit)).toBe(16200);
      expect(Number(result.totals.totalCredit)).toBe(16200);
    });

    // ── V6a-sort: all sort values return the same balanced totals ─────────────
    // Expected row sequences derived from SORT_ORDER in gl-journal.repository.ts:
    //   GL 1200: debit 16,200 / credit 0   |  GL 2200: debit 0 / credit 200
    //   GL 4000: debit 0 / credit 16,000
    // Tie-breaker for equal primary values is always gl_code ASC (string order).
    it("V6a-sort — sort variants return same totals and the correct GL code sequence", async () => {
      const EXPECTED: Record<string, string[]> = {
        "-gl_code": ["4000", "2200", "1200"],
        debit: ["2200", "4000", "1200"], // 0 ASC tie-broken by gl_code → 2200,4000; then 16200
        "-debit": ["1200", "2200", "4000"], // 16200 DESC first; 0 tie-broken by gl_code → 2200,4000
        credit: ["1200", "2200", "4000"], // 0 ASC, then 200, then 16000
        "-credit": ["4000", "2200", "1200"], // 16000 DESC first, then 200, then 0
      };

      for (const sort of [
        "-gl_code",
        "debit",
        "-debit",
        "credit",
        "-credit",
      ] as const) {
        const result = await getPeriodSummary(PERIOD_JULY, "movement", sort);
        expect(result.totals.balanced).toBe(true);
        expect(Number(result.totals.totalDebit)).toBe(16200);
        expect(Number(result.totals.totalCredit)).toBe(16200);
        expect(result.rows).toHaveLength(3);
        expect(result.rows.map((r) => r.glCode)).toEqual(EXPECTED[sort]);
      }
    });

    // ── V6a-trial: trial-balance sort variants are also valid ─────────────────
    it("V6a-trial — trial-balance view with debit/-debit/credit/-credit sorts returns balanced totals", async () => {
      for (const sort of ["debit", "-debit", "credit", "-credit"] as const) {
        const result = await getPeriodSummary(PERIOD_JULY, "trial", sort);
        expect(result.totals.balanced).toBe(true);
        expect(Number(result.totals.totalDebit)).toBe(16200);
        expect(Number(result.totals.totalCredit)).toBe(16200);
      }
      // Spot-check: sort="debit" (ASC) puts the credit-only codes (4000, 2200)
      // first (debit = 0) and GL 1200 last (debit = 16,200).
      const sorted = await getPeriodSummary(PERIOD_JULY, "trial", "debit");
      const codes = sorted.rows.map((r) => r.glCode);
      expect(codes.indexOf("1200")).toBeGreaterThan(codes.indexOf("4000"));
    });

    // ── V6b: per-GL-code totals reconcile to pgledger_entries_view sums ──────
    it("V6b — GL 1200 debit 16,200 / GL 4000 credit 16,000 / GL 2200 credit 200", async () => {
      const result = await getPeriodSummary(PERIOD_JULY, "movement", "gl_code");
      const byCode = new Map(result.rows.map((r) => [r.glCode, r]));

      expect(Number(byCode.get("1200")?.debit ?? -1)).toBe(16200);
      expect(Number(byCode.get("1200")?.credit ?? -1)).toBe(0);
      expect(Number(byCode.get("4000")?.credit ?? -1)).toBe(16000);
      expect(Number(byCode.get("2200")?.credit ?? -1)).toBe(200);

      // Cross-check GL 1200 against raw pgledger_entries_view sums (V6 §3.5)
      const [rawRow] = await sql<{ debit: string; credit: string }[]>`
        SELECT
          sum(CASE WHEN pev.amount > 0 THEN pev.amount ELSE 0 END)::text AS debit,
          sum(CASE WHEN pev.amount < 0 THEN -pev.amount ELSE 0 END)::text AS credit
        FROM billing.pgledger_entries_view pev
        JOIN billing.gl_resolution_view grv ON grv.pgledger_account_id = pev.account_id
        WHERE grv.gl_code = '1200'
          AND to_char(pev.event_at, 'YYYY-MM') = ${PERIOD_JULY}
      `;
      expect(Number(rawRow?.debit ?? 0)).toBe(16200);
      expect(Number(rawRow?.credit ?? 0)).toBe(0);
    });

    // ── V6c: drill-down of GL 1200 lists contributing entries ───────────────
    it("V6c — drill-down of GL 1200 lists exactly 2 A/R entries (charge 16,000 + tax 200) referencing the DBN document", async () => {
      const { entries, truncated } = await getCodeDrilldown(
        "1200",
        PERIOD_JULY,
        "movement",
      );
      expect(truncated).toBe(false);
      expect(entries).toHaveLength(2);
      const amounts = entries
        .map((e) => Number(e.amount))
        .sort((a, b) => a - b);
      expect(amounts).toEqual([200, 16000]);
      for (const e of entries) {
        expect(e.docId).toBe(dbnDocumentId);
      }
    });

    // ── V6d: deliberately imbalanced fixture → balanced: false ───────────────
    // An unmapped pgledger account (no ledger_binding, no GL mapping) creates
    // an apparent imbalance: only the mapped side of the transfer appears in
    // gl_journal_view. Uses August so the July 16,200/16,200 assertions above
    // are unaffected.
    describe("imbalance fixture (unmapped account in August)", () => {
      let revenueMyrId: string;

      beforeAll(async () => {
        const [revenueAcct] = await sql<{ id: string }[]>`
          SELECT id FROM billing.pgledger_accounts_view
          WHERE name = 'sys.revenue.MYR' LIMIT 1
        `;
        revenueMyrId = revenueAcct!.id;

        // Create an unmapped account and post a transfer to sys.revenue in Aug
        const [unmapped] = await sql<{ id: string }[]>`
          SELECT id FROM billing.pgledger_create_account('test.v06.unmapped', 'MYR')
        `;
        await sql`
          SELECT FROM billing.pgledger_create_transfers(
            ARRAY[(${unmapped!.id}, ${revenueMyrId}, '500.00'::numeric)::billing.transfer_request],
            '2026-08-01T00:00:00Z'::timestamptz,
            '{"doc": "V06-IMBALANCE"}'::jsonb
          )
        `;
      });

      it("V6d — unmapped account transfer makes August period unbalanced (balanced: false)", async () => {
        const result = await getPeriodSummary("2026-08", "movement", "gl_code");
        // Only GL 4000 debit 500 appears; the unmapped account's credit is excluded
        expect(result.totals.balanced).toBe(false);
        expect(Number(result.totals.totalDebit)).toBeGreaterThan(0);
        expect(result.totals.totalDebit).not.toBe(result.totals.totalCredit);
      });
    });

    // ── V6e: trial-balance cumulative scope ───────────────────────────────────
    // The toBeGreaterThanOrEqual bounds are intentionally inclusive: the nested
    // V6d imbalance fixture adds a 500-unit August transfer to sys.revenue (GL
    // 4000), so the August trial-balance cumulative for GL 4000 credit is at
    // least 16,000 (July DBN) + 500 (August unmapped transfer) = 16,500.
    it("V6e — trial-balance scope for August includes July DBN entries (GL 1200 debit ≥ 16,200)", async () => {
      const trial = await getPeriodSummary("2026-08", "trial", "gl_code");
      const byCode = new Map(trial.rows.map((r) => [r.glCode, r]));
      expect(Number(byCode.get("1200")?.debit ?? 0)).toBeGreaterThanOrEqual(
        16200,
      );
      expect(Number(byCode.get("4000")?.credit ?? 0)).toBeGreaterThanOrEqual(
        16000,
      );
    });

    // ── V1 zero-sum is maintained throughout ─────────────────────────────────
    it("V1 — zero-sum holds after all postings", async () => {
      expect(await zeroSum()).toBe(0);
    });
  },
);
