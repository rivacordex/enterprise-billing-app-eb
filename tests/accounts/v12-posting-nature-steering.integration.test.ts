import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { db } from "@/db/client";
import { onboardCustomerAccounts } from "@/services/accounts/onboard-customer-accounts";
import { raiseDebitNote } from "@/services/accounts/raise-debit-note";
import { raiseCreditNote } from "@/services/accounts/raise-credit-note";
import { writeOff } from "@/services/accounts/write-off";
import { roundingAdjustment } from "@/services/accounts/rounding-adjustment";
import { raiseDebitNoteSchema } from "@/validation/accounts/raise-debit-note.schema";
import { raiseCreditNoteSchema } from "@/validation/accounts/raise-credit-note.schema";
import { writeOffSchema } from "@/validation/accounts/write-off.schema";
import { roundingAdjustmentSchema } from "@/validation/accounts/rounding-adjustment.schema";
import { approveDocument } from "@/services/accounts/document-state-machine";

// ac09-spec §3.6 / ac10-spec §3.6 v12-posting-nature-steering.integration.test.ts
// — V12: a DBN `MANUAL_CHARGE` debits A/R and credits `sys.revenue` (GL
// 4000), its optional tax line credits `sys.tax_payable` (GL 2200); a CRN
// `GOODWILL_CREDIT` credits `sys.revenue_adj` (GL 4090); an ADJ
// `BAD_DEBT_WRITEOFF` debits `sys.write_off` (GL 6100); an ADJ
// `ROUNDING_ADJ` clears a small residue to `sys.rounding` (GL 6900, either
// direction depending on the residue's sign). All four reuse the same
// generic `post-document`/`leg-templates` machinery — the sys counter-
// account comes purely from the reason code's `posting_nature` (Module Inv.
// #8), never a per-page literal. Thresholds (DBN 10,000 / CRN 1,000 /
// write-off 0 (always) / rounding 10) route to approval and reject
// self-approval. V1 zero-sum after every step.
const databaseUrl = process.env.DATABASE_URL;
const EVENT_AT = new Date("2026-03-05T00:00:00.000Z");
const PERIOD = "2026-03";

describe.skipIf(!databaseUrl)(
  "V12 — posting-nature steering (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let creatorId: string;
    let managerId: string;
    let financialAccountId: string;
    let billingAccountId: string;
    let receivablesAccountId: string;

    async function balanceOf(accountId: string): Promise<number> {
      const [row] = await sql<{ balance: string }[]>`
        SELECT balance::text AS balance
        FROM billing.pgledger_accounts_view
        WHERE id = ${accountId}
      `;
      return Number(row!.balance);
    }

    async function zeroSum(): Promise<number> {
      const [row] = await sql<{ total: string | null }[]>`
        SELECT sum(balance)::text AS total FROM billing.pgledger_accounts_view
      `;
      return Number(row?.total ?? "0");
    }

    async function glJournalRow(
      glCode: string,
    ): Promise<{ debit: number; credit: number }> {
      const [row] = await sql<{ debit: string; credit: string }[]>`
        SELECT debit::text AS debit, credit::text AS credit
        FROM billing.gl_journal_view
        WHERE gl_code = ${glCode} AND period = ${PERIOD}
      `;
      return {
        debit: Number(row?.debit ?? "0"),
        credit: Number(row?.credit ?? "0"),
      };
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);

      // Schema drop + migrate on a short-lived connection, then a fresh one
      // for everything else — see ledger-explorer.integration.test.ts's
      // beforeAll comment (migrate() poisons its own connection's type-OID
      // cache).
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

      const [creator] = await sql<{ id: string }[]>`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES ('test-user-v12-creator', 'V12 Creator', 'v12-creator@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id
      `;
      creatorId = creator!.id;

      const [manager] = await sql<{ id: string }[]>`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES ('test-user-v12-manager', 'V12 Manager', 'v12-manager@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id
      `;
      managerId = manager!.id;

      // Minimal CoA + gl_mapping fixture (§3.6 — this is what V12 asserts
      // against): 4000 (revenue), 4090 (revenue_adj), 2200 (tax_payable),
      // 6100 (write-off, ac10-spec §1), 6900 (rounding, ac10-spec §1).
      await sql`
        INSERT INTO billing.gl_account (gl_code, name, account_class, normal_balance, is_postable)
        VALUES
          ('4000', 'Service Revenue', 'revenue', 'credit', true),
          ('4090', 'Revenue Adjustments', 'revenue', 'credit', true),
          ('2200', 'SST Payable', 'liability', 'credit', true),
          ('6100', 'Bad Debt Expense', 'expense', 'debit', true),
          ('6900', 'Rounding Differences', 'expense', 'debit', true)
      `;
      await sql`
        INSERT INTO billing.gl_mapping (selector_type, selector, currency, ref_gl_code)
        VALUES
          ('system_account', 'sys.revenue.MYR', 'MYR', '4000'),
          ('system_account', 'sys.revenue_adj.MYR', 'MYR', '4090'),
          ('system_account', 'sys.tax_payable.MYR', 'MYR', '2200'),
          ('system_account', 'sys.write_off.MYR', 'MYR', '6100'),
          ('system_account', 'sys.rounding.MYR', 'MYR', '6900')
      `;

      await sql`SELECT id FROM billing.pgledger_create_account('sys.revenue.MYR', 'MYR')`;
      await sql`SELECT id FROM billing.pgledger_create_account('sys.revenue_adj.MYR', 'MYR')`;
      await sql`SELECT id FROM billing.pgledger_create_account('sys.tax_payable.MYR', 'MYR')`;
      await sql`SELECT id FROM billing.pgledger_create_account('sys.write_off.MYR', 'MYR')`;
      await sql`SELECT id FROM billing.pgledger_create_account('sys.rounding.MYR', 'MYR')`;

      await sql`
        INSERT INTO billing.reason_code (reason_code, doc_type, posting_nature, auto_post_limit, state)
        VALUES
          ('MANUAL_CHARGE', 'DBN', 'revenue', 10000.00, 'active'),
          ('GOODWILL_CREDIT', 'CRN', 'revenue_adj', 1000.00, 'active'),
          ('BAD_DEBT_WRITEOFF', 'ADJ', 'write_off', 0.00, 'active'),
          ('ROUNDING_ADJ', 'ADJ', 'rounding', 10.00, 'active')
      `;

      const [cycle] = await sql<{ id: string }[]>`
        INSERT INTO billing.bill_cycle (name, frequency, cycle_day, payment_due_days, state)
        VALUES ('V12 Monthly', 'monthly', 1, 30, 'active')
        RETURNING bill_cycle_id AS id
      `;

      const [org] = await sql<{ id: string }[]>`
        INSERT INTO customer.organization (name, organization_type, last_modified_by)
        VALUES ('V12 Test Corp', 'COMPANY', ${creatorId})
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
          statusReason: "V12 posting-nature-steering test",
          lastModifiedDatetime: pr!.ts,
        },
        creatorId,
      );
      if (!onboarded.ok)
        throw new Error(`onboarding failed: ${onboarded.code}`);
      financialAccountId = onboarded.value.financialAccountId;
      billingAccountId = onboarded.value.billingAccountId;

      const [recBinding] = await sql<{ pgledger_account_id: string }[]>`
        SELECT pgledger_account_id FROM billing.ledger_binding
        WHERE owner_type = 'billing_account' AND owner_id = ${billingAccountId} AND ledger_role = 'receivables'
      `;
      receivablesAccountId = recBinding!.pgledger_account_id;
    }, 60_000);

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    it("raise-debit-note / raise-credit-note / write-off / rounding-adjustment all require a BAN (Q1) — rejected before any posting", () => {
      const dbnWithoutBan = raiseDebitNoteSchema.safeParse({
        financialAccountId,
        netAmount: "100.00",
        taxAmount: null,
        eventAt: EVENT_AT,
        referenceDate: EVENT_AT,
        referenceInfo: "no BAN",
      });
      expect(dbnWithoutBan.success).toBe(false);

      const crnWithoutBan = raiseCreditNoteSchema.safeParse({
        financialAccountId,
        amount: "100.00",
        eventAt: EVENT_AT,
        referenceDate: EVENT_AT,
        referenceInfo: "no BAN",
      });
      expect(crnWithoutBan.success).toBe(false);

      const writeOffWithoutBan = writeOffSchema.safeParse({
        financialAccountId,
        amount: "100.00",
        eventAt: EVENT_AT,
        referenceDate: EVENT_AT,
        referenceInfo: "no BAN",
      });
      expect(writeOffWithoutBan.success).toBe(false);

      const roundingWithoutBan = roundingAdjustmentSchema.safeParse({
        financialAccountId,
        amount: "0.05",
        eventAt: EVENT_AT,
        referenceDate: EVENT_AT,
        referenceInfo: "no BAN",
      });
      expect(roundingWithoutBan.success).toBe(false);
    });

    it("DBN MANUAL_CHARGE ≤ 10,000 posts directly — net 5,000 + tax 400 debits A/R 5,400, credits sys.revenue (GL 4000) 5,000 and sys.tax_payable (GL 2200) 400", async () => {
      const result = await raiseDebitNote(
        {
          financialAccountId,
          billingAccountId,
          netAmount: "5000.00",
          taxAmount: "400.00",
          eventAt: EVENT_AT,
          referenceDate: EVENT_AT,
          referenceInfo: "V12 DBN direct",
        },
        creatorId,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.state).toBe("posted");

      expect(await balanceOf(receivablesAccountId)).toBe(5400);
      expect(await glJournalRow("4000")).toEqual({ debit: 0, credit: 5000 });
      expect(await glJournalRow("2200")).toEqual({ debit: 0, credit: 400 });
      expect(await zeroSum()).toBe(0);
    });

    it("DBN above 10,000 routes to pending_approval, rejects self-approval, and a non-creator MANAGER posts it — sys.revenue (GL 4000) accumulates to 16,000", async () => {
      const raised = await raiseDebitNote(
        {
          financialAccountId,
          billingAccountId,
          netAmount: "11000.00",
          taxAmount: null,
          eventAt: EVENT_AT,
          referenceDate: EVENT_AT,
          referenceInfo: "V12 DBN above limit",
        },
        creatorId,
      );
      expect(raised.ok).toBe(true);
      if (!raised.ok) return;
      expect(raised.value.state).toBe("pending_approval");

      const selfApprove = await db.transaction((tx) =>
        approveDocument(tx, raised.value.documentId, creatorId),
      );
      expect(selfApprove).toEqual({ ok: false, code: "SELF_APPROVAL" });

      const approved = await db.transaction((tx) =>
        approveDocument(tx, raised.value.documentId, managerId),
      );
      expect(approved.ok).toBe(true);
      if (!approved.ok) return;
      expect(approved.value.state).toBe("posted");

      expect(await balanceOf(receivablesAccountId)).toBe(16400);
      expect(await glJournalRow("4000")).toEqual({ debit: 0, credit: 16000 });
      expect(await zeroSum()).toBe(0);
    });

    it("CRN GOODWILL_CREDIT ≤ 1,000 posts directly — 800 reduces A/R, credits sys.revenue_adj (GL 4090) 800", async () => {
      const result = await raiseCreditNote(
        {
          financialAccountId,
          billingAccountId,
          amount: "800.00",
          eventAt: EVENT_AT,
          referenceDate: EVENT_AT,
          referenceInfo: "V12 CRN direct",
        },
        creatorId,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.state).toBe("posted");

      expect(await balanceOf(receivablesAccountId)).toBe(15600);
      expect(await glJournalRow("4090")).toEqual({ debit: 800, credit: 0 });
      expect(await zeroSum()).toBe(0);
    });

    it("CRN above 1,000 routes to pending_approval, rejects self-approval, and a non-creator MANAGER posts it — sys.revenue_adj (GL 4090) accumulates to 2,300; the same generic services steered to a different GL code (4090, not DBN's 4000) purely from the reason code", async () => {
      const raised = await raiseCreditNote(
        {
          financialAccountId,
          billingAccountId,
          amount: "1500.00",
          eventAt: EVENT_AT,
          referenceDate: EVENT_AT,
          referenceInfo: "V12 CRN above limit",
        },
        creatorId,
      );
      expect(raised.ok).toBe(true);
      if (!raised.ok) return;
      expect(raised.value.state).toBe("pending_approval");

      const selfApprove = await db.transaction((tx) =>
        approveDocument(tx, raised.value.documentId, creatorId),
      );
      expect(selfApprove).toEqual({ ok: false, code: "SELF_APPROVAL" });

      const approved = await db.transaction((tx) =>
        approveDocument(tx, raised.value.documentId, managerId),
      );
      expect(approved.ok).toBe(true);
      if (!approved.ok) return;
      expect(approved.value.state).toBe("posted");

      expect(await balanceOf(receivablesAccountId)).toBe(14100);
      expect(await glJournalRow("4090")).toEqual({ debit: 2300, credit: 0 });
      // DBN's own GL row is untouched by this CRN — confirms the sys
      // counter-account is steered per-document from the reason code, never
      // hard-coded per page (Module Inv. #8).
      expect(await glJournalRow("4000")).toEqual({ debit: 0, credit: 16000 });
      expect(await zeroSum()).toBe(0);
    });

    it("a well-formed but unrelated BAN is rejected (BILLING_ACCOUNT_NOT_FOUND)", async () => {
      const dbnResult = await raiseDebitNote(
        {
          financialAccountId,
          billingAccountId: "BAN999999",
          netAmount: "100.00",
          taxAmount: null,
          eventAt: EVENT_AT,
          referenceDate: EVENT_AT,
          referenceInfo: "cross-BAN charge attempt",
        },
        creatorId,
      );
      expect(dbnResult).toEqual({
        ok: false,
        code: "BILLING_ACCOUNT_NOT_FOUND",
      });

      const crnResult = await raiseCreditNote(
        {
          financialAccountId,
          billingAccountId: "BAN999999",
          amount: "100.00",
          eventAt: EVENT_AT,
          referenceDate: EVENT_AT,
          referenceInfo: "cross-BAN credit attempt",
        },
        creatorId,
      );
      expect(crnResult).toEqual({
        ok: false,
        code: "BILLING_ACCOUNT_NOT_FOUND",
      });
    });

    it("write-off BAD_DEBT_WRITEOFF is always four-eyes (limit 0) — rejects self-approval, a non-creator MANAGER posts it, debits sys.write_off (GL 6100) and reduces A/R, leaving a small 0.05 residue", async () => {
      // receivablesAccountId is at 14100.00 after the CRN tests above.
      // Write off all but 5 sen, leaving a debit residue for the next test.
      const raised = await writeOff(
        {
          financialAccountId,
          billingAccountId,
          amount: "14099.95",
          eventAt: EVENT_AT,
          referenceDate: EVENT_AT,
          referenceInfo: "V12 write-off",
        },
        creatorId,
      );
      expect(raised.ok).toBe(true);
      if (!raised.ok) return;
      expect(raised.value.state).toBe("pending_approval");

      const selfApprove = await db.transaction((tx) =>
        approveDocument(tx, raised.value.documentId, creatorId),
      );
      expect(selfApprove).toEqual({ ok: false, code: "SELF_APPROVAL" });

      const approved = await db.transaction((tx) =>
        approveDocument(tx, raised.value.documentId, managerId),
      );
      expect(approved.ok).toBe(true);
      if (!approved.ok) return;
      expect(approved.value.state).toBe("posted");

      expect(await balanceOf(receivablesAccountId)).toBe(0.05);
      expect(await glJournalRow("6100")).toEqual({
        debit: 14099.95,
        credit: 0,
      });
      expect(await zeroSum()).toBe(0);
    });

    it("a write-off amount exceeding the open A/R balance is rejected (AMOUNT_EXCEEDS_OPEN_RECEIVABLE)", async () => {
      const result = await writeOff(
        {
          financialAccountId,
          billingAccountId,
          amount: "1.00",
          eventAt: EVENT_AT,
          referenceDate: EVENT_AT,
          referenceInfo: "exceeds open A/R",
        },
        creatorId,
      );
      expect(result).toEqual({
        ok: false,
        code: "AMOUNT_EXCEEDS_OPEN_RECEIVABLE",
      });
    });

    it("rounding ROUNDING_ADJ ≤ 10 posts directly for a debit/positive residue — clears the 0.05 residue via ban.receivables → sys.rounding (GL 6900)", async () => {
      const result = await roundingAdjustment(
        {
          financialAccountId,
          billingAccountId,
          amount: "0.05",
          eventAt: EVENT_AT,
          referenceDate: EVENT_AT,
          referenceInfo: "V12 rounding — debit residue",
        },
        creatorId,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.state).toBe("posted");

      expect(await balanceOf(receivablesAccountId)).toBe(0);
      expect(await glJournalRow("6900")).toEqual({ debit: 0.05, credit: 0 });
      expect(await zeroSum()).toBe(0);
    });

    it("rounding-adjustment on a zero balance is rejected (NO_RESIDUE_TO_CLEAR)", async () => {
      const result = await roundingAdjustment(
        {
          financialAccountId,
          billingAccountId,
          amount: "0.01",
          eventAt: EVENT_AT,
          referenceDate: EVENT_AT,
          referenceInfo: "no residue",
        },
        creatorId,
      );
      expect(result).toEqual({ ok: false, code: "NO_RESIDUE_TO_CLEAR" });
    });

    it("rounding direction reverses for a credit/negative residue — sys.rounding → ban.receivables (GL 6900) clears an overshoot from a small CRN", async () => {
      // Push receivables to a small credit balance (-0.07) with a direct-post
      // CRN, then confirm rounding clears it via the reversed leg.
      const crn = await raiseCreditNote(
        {
          financialAccountId,
          billingAccountId,
          amount: "0.07",
          eventAt: EVENT_AT,
          referenceDate: EVENT_AT,
          referenceInfo: "V12 rounding setup — small overshoot",
        },
        creatorId,
      );
      expect(crn.ok).toBe(true);
      if (!crn.ok) return;
      expect(crn.value.state).toBe("posted");
      expect(await balanceOf(receivablesAccountId)).toBe(-0.07);

      const result = await roundingAdjustment(
        {
          financialAccountId,
          billingAccountId,
          amount: "0.07",
          eventAt: EVENT_AT,
          referenceDate: EVENT_AT,
          referenceInfo: "V12 rounding — credit residue",
        },
        creatorId,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.state).toBe("posted");

      expect(await balanceOf(receivablesAccountId)).toBe(0);
      // GL 6900 now carries both the earlier debit-residue clearing (0.05,
      // the `charge` leg direction) and this credit-residue clearing (0.07,
      // the reversed `release` leg direction) — confirming direction follows
      // the live residue sign rather than a fixed shape (§2.2).
      expect(await glJournalRow("6900")).toEqual({ debit: 0.05, credit: 0.07 });
      expect(await zeroSum()).toBe(0);
    });

    it("V12 — end-state: V1 zero-sum holds", async () => {
      expect(await zeroSum()).toBe(0);
    });
  },
);
