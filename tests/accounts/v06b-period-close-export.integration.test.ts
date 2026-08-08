import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { onboardCustomerAccounts } from "@/services/accounts/onboard-customer-accounts";
import { raiseDebitNote } from "@/services/accounts/raise-debit-note";
import { closePeriod, getPeriodState } from "@/services/accounts/period-close";
import {
  buildJournalCsv,
  serializeJournalCsv,
} from "@/services/accounts/journal-csv";
import { redateAndResubmit } from "@/services/accounts/document-state-machine";

// ac14-spec §3.8 — V6b: period close, PERIOD_CLOSED rejection, re-date
// re-submission, and CSV export. Runs on top of the same onboarding + CoA
// fixture as V6 (v06-journal-balance.integration.test.ts) but in a fresh
// schema so the two test files are order-independent.
const databaseUrl = process.env.DATABASE_URL;
const EVENT_AT_JULY = new Date("2026-07-10T00:00:00.000Z");
const EVENT_AT_AUG = new Date("2026-08-01T00:00:00.000Z");
const PERIOD_JULY = "2026-07";
const PERIOD_AUG = "2026-08";
const PERIOD_SEP = "2026-09";

describe.skipIf(!databaseUrl)(
  "V6b — period close, re-date, CSV export (ac14-spec §3.8, requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let actorId: string;
    let financialAccountId: string;
    let billingAccountId: string;

    async function zeroSum(): Promise<number> {
      const [row] = await sql<{ total: string | null }[]>`
        SELECT sum(balance)::text AS total FROM billing.pgledger_accounts_view
      `;
      return Number(row?.total ?? "0");
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);

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

      // ── Actor user ─────────────────────────────────────────────────────────
      const [actor] = await sql<{ id: string }[]>`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES ('test-v06b-actor', 'V06b Actor', 'v06b-actor@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id
      `;
      actorId = actor!.id;

      // ── Sys pgledger accounts ──────────────────────────────────────────────
      for (const name of [
        "sys.cash.MYR",
        "sys.revenue.MYR",
        "sys.tax_payable.MYR",
      ]) {
        await sql`SELECT id FROM billing.pgledger_create_account(${name}, 'MYR')`;
      }

      // ── Chart of Accounts ──────────────────────────────────────────────────
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

      // ── Reason code (limit 10,000 — net<=10,000 auto-posts) ───────────────
      await sql`
        INSERT INTO billing.reason_code (reason_code, doc_type, posting_nature, auto_post_limit, state)
        VALUES ('MANUAL_CHARGE', 'DBN', 'revenue', '10000.00', 'active')
      `;

      const [cycle] = await sql<{ id: string }[]>`
        INSERT INTO billing.bill_cycle (name, frequency, cycle_day, payment_due_days, state)
        VALUES ('V06b Monthly', 'monthly', 1, 30, 'active')
        RETURNING bill_cycle_id AS id
      `;

      const [org] = await sql<{ id: string }[]>`
        INSERT INTO customer.organization (name, organization_type, last_modified_by)
        VALUES ('V06b Test Corp', 'COMPANY', ${actorId})
        RETURNING organization_id AS id
      `;
      const [pr] = await sql<{ id: string; ts: Date }[]>`
        INSERT INTO customer.party_role (engaged_party, status, last_modified_by)
        VALUES (${org!.id}, 'INITIALIZED', ${actorId})
        RETURNING party_role_id AS id, last_modified_datetime AS ts
      `;

      const onboarded = await onboardCustomerAccounts(
        {
          partyRoleId: pr!.id,
          billCycleId: cycle!.id,
          currency: "MYR",
          statusReason: "V06b period close test",
          lastModifiedDatetime: pr!.ts,
        },
        actorId,
      );
      if (!onboarded.ok)
        throw new Error(`onboarding failed: ${onboarded.code}`);
      financialAccountId = onboarded.value.financialAccountId;
      billingAccountId = onboarded.value.billingAccountId;

      // Seed: one posted DBN in July so the journal has data to export.
      // 5,000 net / 0 tax — below the 10,000 limit so it auto-posts.
      const seeded = await raiseDebitNote(
        {
          financialAccountId,
          billingAccountId,
          netAmount: "5000.00",
          taxAmount: null,
          eventAt: EVENT_AT_JULY,
          entryDate: EVENT_AT_JULY,
          referenceInfo: "V06b July seed DBN",
        },
        actorId,
      );
      if (!seeded.ok || seeded.value.state !== "posted")
        throw new Error(`seed DBN failed: ${JSON.stringify(seeded)}`);

      // V1 zero-sum must hold after seeding
      expect(await zeroSum()).toBe(0);
    }, 60_000);

    afterAll(async () => {
      if (!sql) return;
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    // ── Period state before close ───────────────────────────────────────────
    it("V6b-1 — getPeriodState returns open for a period with no accounting_period row (spec §2.1)", async () => {
      const state = await getPeriodState(PERIOD_JULY, "MYR");
      expect(state).toBe("open");
    });

    // ── closePeriod ─────────────────────────────────────────────────────────
    it("V6b-2 — closePeriod returns ok:true and transitions July to closed (spec §2.1)", async () => {
      const result = await closePeriod(PERIOD_JULY, "MYR", actorId);
      expect(result.ok).toBe(true);

      const state = await getPeriodState(PERIOD_JULY, "MYR");
      expect(state).toBe("closed");
    });

    // ── Idempotency ─────────────────────────────────────────────────────────
    it("V6b-3 — closePeriod on an already-closed period returns ALREADY_CLOSED (idempotent, spec §2.1 / Inv. #7)", async () => {
      const result = await closePeriod(PERIOD_JULY, "MYR", actorId);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("ALREADY_CLOSED");
    });

    // ── PERIOD_CLOSED rejection ─────────────────────────────────────────────
    it("V6b-4 — raiseDebitNote with a closed period's event_at returns PERIOD_CLOSED and commits the draft", async () => {
      const result = await raiseDebitNote(
        {
          financialAccountId,
          billingAccountId,
          netAmount: "3000.00",
          taxAmount: null,
          eventAt: EVENT_AT_JULY,
          entryDate: EVENT_AT_JULY,
          referenceInfo: "V06b PERIOD_CLOSED test draft",
        },
        actorId,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("PERIOD_CLOSED");

      // The draft must be committed to the DB so re-date can find it
      const [draft] = await sql<{ id: string; state: string }[]>`
        SELECT document_id AS id, state
        FROM billing.document
        WHERE ref_billing_account_id = ${billingAccountId}
          AND reference_info = 'V06b PERIOD_CLOSED test draft'
        LIMIT 1
      `;
      expect(draft).toBeDefined();
      expect(draft!.state).toBe("draft");
    });

    // ── Re-date and re-submit ───────────────────────────────────────────────
    it("V6b-5 — redateAndResubmit with an open period's event_at posts the draft (spec §2.2)", async () => {
      const [draft] = await sql<{ id: string; last_modified: Date }[]>`
        SELECT document_id AS id, last_modified
        FROM billing.document
        WHERE ref_billing_account_id = ${billingAccountId}
          AND reference_info = 'V06b PERIOD_CLOSED test draft'
          AND state = 'draft'
        LIMIT 1
      `;
      expect(draft).toBeDefined();

      const result = await redateAndResubmit(
        draft!.id,
        EVENT_AT_AUG,
        draft!.last_modified,
        actorId,
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.state).toBe("posted");

      // The document should no longer be draft
      const [updated] = await sql<{ state: string }[]>`
        SELECT state FROM billing.document WHERE document_id = ${draft!.id}
      `;
      expect(updated!.state).toBe("posted");

      // V1 zero-sum still holds after re-submission
      expect(await zeroSum()).toBe(0);
    });

    // ── CSV export — balanced journal ────────────────────────────────────────
    it("V6b-6 — buildJournalCsv returns ok:true for a balanced July journal (spec §2.3)", async () => {
      const result = await buildJournalCsv(PERIOD_JULY);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // July has the 5,000 seed DBN: GL 1200 debit 5,000 / GL 4000 credit 5,000
      expect(Number(result.totalDebit)).toBe(5000);
      expect(Number(result.totalCredit)).toBe(5000);
      expect(result.rowCount).toBeGreaterThan(0);
    });

    // ── CRLF line endings ───────────────────────────────────────────────────
    it("V6b-7 — CSV output uses CRLF line endings and ends with CRLF (RFC 4180 / spec §2.3)", async () => {
      const result = await buildJournalCsv(PERIOD_JULY);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Every line break must be CRLF, not bare LF
      expect(result.csv).toContain("\r\n");
      expect(result.csv).not.toMatch(/(?<!\r)\n/);
      // Last line also ends with CRLF per RFC 4180
      expect(result.csv.endsWith("\r\n")).toBe(true);
    });

    // ── CSV header ──────────────────────────────────────────────────────────
    it("V6b-8 — CSV starts with the correct header row (spec §2.3)", async () => {
      const result = await buildJournalCsv(PERIOD_JULY);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.csv.startsWith("gl_code,gl_name,debit,credit\r\n")).toBe(
        true,
      );
    });

    // ── serializeJournalCsv pure unit ────────────────────────────────────────
    it("V6b-9 — serializeJournalCsv escapes commas and quotes; produces RFC 4180 output (pure unit)", () => {
      const rows = [
        {
          glCode: "1200",
          name: "Accounts Receivable",
          debit: "5000.00",
          credit: "0.00",
        },
        {
          glCode: "4000",
          name: 'Revenue, "Main"',
          debit: "0.00",
          credit: "5000.00",
        },
      ];
      const csv = serializeJournalCsv(rows);

      // Header
      expect(csv).toContain("gl_code,gl_name,debit,credit\r\n");
      // Comma + quote in name → double-quote escaped
      expect(csv).toContain('"Revenue, ""Main"""');
      // All line endings are CRLF
      expect(csv).not.toMatch(/(?<!\r)\n/);
      // Trailing CRLF
      expect(csv.endsWith("\r\n")).toBe(true);
    });

    // ── Unbalanced guard ─────────────────────────────────────────────────────
    // An unmapped pgledger account (no ledger_binding, no GL mapping) creates
    // an imbalance in gl_journal_view: only the mapped side appears. Reproduces
    // Module Inv. #10 guard — identical technique to V6d in v06-journal-balance.
    it("V6b-10 — buildJournalCsv returns UNBALANCED_JOURNAL for a period with an unmapped transfer (Inv. #10)", async () => {
      const [revenueAcct] = await sql<{ id: string }[]>`
        SELECT id FROM billing.pgledger_accounts_view
        WHERE name = 'sys.revenue.MYR' LIMIT 1
      `;
      const [unmapped] = await sql<{ id: string }[]>`
        SELECT id FROM billing.pgledger_create_account('test.v06b.unmapped', 'MYR')
      `;
      // Transfer 700 from unmapped account to sys.revenue in September
      await sql`
        SELECT FROM billing.pgledger_create_transfers(
          ARRAY[(${unmapped!.id}, ${revenueAcct!.id}, '700.00'::numeric)::billing.transfer_request],
          '2026-09-01T00:00:00Z'::timestamptz,
          '{"doc": "V06B-IMBALANCE"}'::jsonb
        )
      `;

      const result = await buildJournalCsv(PERIOD_SEP);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("UNBALANCED_JOURNAL");
        // One side is non-zero; the other is zero (unmapped account not in view)
        expect(result.totalDebit).not.toBe(result.totalCredit);
      }
    });

    // ── V1 zero-sum holds throughout ────────────────────────────────────────
    it("V1 — zero-sum holds at the end of V6b (all pgledger entries balance)", async () => {
      expect(await zeroSum()).toBe(0);
    });

    // ── August journal CSV ──────────────────────────────────────────────────
    it("V6b-11 — buildJournalCsv for August (redated entry) is balanced with debit 3,000 (spec §2.3)", async () => {
      const result = await buildJournalCsv(PERIOD_AUG);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(Number(result.totalDebit)).toBe(3000);
      expect(Number(result.totalCredit)).toBe(3000);
    });
  },
);
