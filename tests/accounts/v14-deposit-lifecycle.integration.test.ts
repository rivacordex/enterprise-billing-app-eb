import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { db } from "@/db/client";
import { onboardCustomerAccounts } from "@/services/accounts/onboard-customer-accounts";
import { allocatePayment } from "@/services/accounts/allocate-payment";
import { captureDeposit } from "@/services/accounts/capture-deposit";
import { reverseDeposit } from "@/services/accounts/reverse-deposit";
import { refundDeposit } from "@/services/accounts/refund-deposit";
import { writeOff } from "@/services/accounts/write-off";
import { approveDocument } from "@/services/accounts/document-state-machine";
import { closeBillingAccount } from "@/services/accounts/close-billing-account";
import { closeFinancialAccount } from "@/services/accounts/close-financial-account";
import { customerHasOpenAccounts } from "@/services/accounts/closure-eligibility";

// ac08-spec §3.6 v14-deposit-lifecycle.integration.test.ts — V14: the full
// security-deposit lifecycle (capture → reverse → allocate → refund) ends
// `deposits = 0`, `unapplied = 0` (Q11 closure eligibility); capture posts
// directly at/below its limit, reverse/refund always route to approval
// (limit 0) and reject self-approval; V1 zero-sum after every step.
//
// ac16-spec §3.7 extends this file to actual closure (rather than a new
// v-file — same "extend the mapped V-test" precedent as ac09/ac10 extending
// v12): write off the residual A/R the V14 sequence deliberately leaves open
// → close-BAN → close-FA → a posting against the now-closed FA is rejected
// (ACCOUNT_CLOSED) → the Customer → CLOSED gate flips from blocked to
// allowed once both accounts are closed.
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "V14 — deposit lifecycle (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let creatorId: string;
    let managerId: string;
    let financialAccountId: string;
    let billingAccountId: string;
    let depositsAccountId: string;
    let unappliedAccountId: string;
    let receivablesAccountId: string;
    let partyRoleId: string;

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
        VALUES ('test-user-v14-creator', 'V14 Creator', 'v14-creator@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id
      `;
      creatorId = creator!.id;

      const [manager] = await sql<{ id: string }[]>`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES ('test-user-v14-manager', 'V14 Manager', 'v14-manager@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id
      `;
      managerId = manager!.id;

      await sql`SELECT id FROM billing.pgledger_create_account('sys.cash.MYR', 'MYR')`;
      const [sysRevenue] = await sql<{ id: string }[]>`
        SELECT id FROM billing.pgledger_create_account('sys.revenue.MYR', 'MYR')
      `;
      // ac16 addition — write-off's counter-account (sys.write_off, Q19),
      // needed to close the residual A/R the V14 sequence deliberately
      // leaves open before closure can be exercised.
      await sql`SELECT id FROM billing.pgledger_create_account('sys.write_off.MYR', 'MYR')`;

      await sql`
        INSERT INTO billing.reason_code (reason_code, doc_type, posting_nature, auto_post_limit, state)
        VALUES
          ('CUST_PAYMENT', 'PAY', 'cash', 100000.00, 'active'),
          ('SEC_DEPOSIT', 'DEP', 'deposit_movement', 50000.00, 'active'),
          ('DEP_REVERSE', 'DEP', 'deposit_movement', 0.00, 'active'),
          ('DEP_REFUND', 'DEP', 'deposit_movement', 0.00, 'active'),
          ('BAD_DEBT_WRITEOFF', 'ADJ', 'write_off', 0.00, 'active')
      `;

      const [cycle] = await sql<{ id: string }[]>`
        INSERT INTO billing.bill_cycle (name, frequency, cycle_day, payment_due_days, state)
        VALUES ('V14 Monthly', 'monthly', 1, 30, 'active')
        RETURNING bill_cycle_id AS id
      `;

      const [org] = await sql<{ id: string }[]>`
        INSERT INTO customer.organization (name, organization_type, last_modified_by)
        VALUES ('V14 Test Corp', 'COMPANY', ${creatorId})
        RETURNING organization_id AS id
      `;
      const [pr] = await sql<{ id: string; ts: Date }[]>`
        INSERT INTO customer.party_role (engaged_party, status, last_modified_by)
        VALUES (${org!.id}, 'INITIALIZED', ${creatorId})
        RETURNING party_role_id AS id, last_modified_datetime AS ts
      `;
      partyRoleId = pr!.id;

      const onboarded = await onboardCustomerAccounts(
        {
          partyRoleId: pr!.id,
          billCycleId: cycle!.id,
          currency: "MYR",
          statusReason: "V14 deposit-lifecycle test",
          lastModifiedDatetime: pr!.ts,
        },
        creatorId,
      );
      if (!onboarded.ok)
        throw new Error(`onboarding failed: ${onboarded.code}`);
      financialAccountId = onboarded.value.financialAccountId;
      billingAccountId = onboarded.value.billingAccountId;

      const [depositsBinding] = await sql<{ pgledger_account_id: string }[]>`
        SELECT pgledger_account_id FROM billing.ledger_binding
        WHERE owner_type = 'financial_account' AND owner_id = ${financialAccountId} AND ledger_role = 'deposits'
      `;
      depositsAccountId = depositsBinding!.pgledger_account_id;

      const [unappliedBinding] = await sql<{ pgledger_account_id: string }[]>`
        SELECT pgledger_account_id FROM billing.ledger_binding
        WHERE owner_type = 'financial_account' AND owner_id = ${financialAccountId} AND ledger_role = 'unapplied_cash'
      `;
      unappliedAccountId = unappliedBinding!.pgledger_account_id;

      // Fixture charge (simulating a DBN before ac09 exists, matching
      // refund-payment.integration.test.ts's precedent) — gives the BAN a
      // real 8,000 A/R balance so the reverse→allocate step has something
      // concrete to settle.
      const [recBinding] = await sql<{ pgledger_account_id: string }[]>`
        SELECT pgledger_account_id FROM billing.ledger_binding
        WHERE owner_type = 'billing_account' AND owner_id = ${billingAccountId} AND ledger_role = 'receivables'
      `;
      receivablesAccountId = recBinding!.pgledger_account_id;
      await sql`
        SELECT * FROM billing.pgledger_create_transfer(
          ${sysRevenue!.id}, ${recBinding!.pgledger_account_id}, 8000.00::numeric, NOW(), '{"doc": "v14-fixture-charge"}'::jsonb
        )
      `;
    }, 60_000);

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    it("capture 10,000 (≤ 50,000 limit) posts directly — depositHeld = 10,000", async () => {
      const result = await captureDeposit(
        {
          financialAccountId,
          amount: "10000.00",
          payment_mode: "cheque",
          mode_ref: { chequeNo: "V14-CAPTURE", bank: "V14 Bank" },
          eventAt: new Date("2026-03-01T00:00:00.000Z"),
          referenceDate: new Date("2026-03-01T00:00:00.000Z"),
          referenceInfo: "V14 capture",
        },
        creatorId,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.state).toBe("posted");

      expect(await balanceOf(depositsAccountId)).toBe(-10000);
      expect(await zeroSum()).toBe(0);
    });

    it("reverse-to-account always routes to pending_approval, rejects self-approval, and a non-creator MANAGER posts it — deposits → 0, unapplied → −10,000", async () => {
      const reversed = await reverseDeposit(
        {
          financialAccountId,
          amount: "10000.00",
          eventAt: new Date("2026-03-02T00:00:00.000Z"),
          referenceDate: new Date("2026-03-02T00:00:00.000Z"),
          referenceInfo: "V14 reverse",
        },
        creatorId,
      );
      expect(reversed.ok).toBe(true);
      if (!reversed.ok) return;
      expect(reversed.value.state).toBe("pending_approval");

      const selfApprove = await db.transaction((tx) =>
        approveDocument(tx, reversed.value.documentId, creatorId),
      );
      expect(selfApprove).toEqual({ ok: false, code: "SELF_APPROVAL" });

      const approved = await db.transaction((tx) =>
        approveDocument(tx, reversed.value.documentId, managerId),
      );
      expect(approved.ok).toBe(true);
      if (!approved.ok) return;
      expect(approved.value.state).toBe("posted");

      expect(await balanceOf(depositsAccountId)).toBe(0);
      expect(await balanceOf(unappliedAccountId)).toBe(-10000);
      expect(await zeroSum()).toBe(0);
    });

    it("allocate 6,000 of the reversed cash against the fixture A/R (ac07 allocation, reused unmodified) — unapplied → −4,000", async () => {
      const allocated = await allocatePayment(
        {
          financialAccountId,
          billingAccountId,
          amount: "6000.00",
          refSettledDocumentId: null,
          eventAt: new Date("2026-03-03T00:00:00.000Z"),
          referenceDate: new Date("2026-03-03T00:00:00.000Z"),
          referenceInfo: "V14 allocation",
        },
        creatorId,
      );
      expect(allocated.ok).toBe(true);
      if (!allocated.ok) return;
      expect(allocated.value.state).toBe("posted");

      expect(await balanceOf(unappliedAccountId)).toBe(-4000);
      expect(await zeroSum()).toBe(0);
    });

    it("refund the 4,000 remainder always routes to pending_approval, rejects self-approval, and a non-creator MANAGER posts it — unapplied → 0", async () => {
      const refunded = await refundDeposit(
        {
          financialAccountId,
          amount: "4000.00",
          paymentMode: "bank_transfer",
          modeRef: { bankRef: "V14-REFUND" },
          eventAt: new Date("2026-03-04T00:00:00.000Z"),
          referenceDate: new Date("2026-03-04T00:00:00.000Z"),
          referenceInfo: "V14 refund",
        },
        creatorId,
      );
      expect(refunded.ok).toBe(true);
      if (!refunded.ok) return;
      expect(refunded.value.state).toBe("pending_approval");

      const selfApprove = await db.transaction((tx) =>
        approveDocument(tx, refunded.value.documentId, creatorId),
      );
      expect(selfApprove).toEqual({ ok: false, code: "SELF_APPROVAL" });

      const approved = await db.transaction((tx) =>
        approveDocument(tx, refunded.value.documentId, managerId),
      );
      expect(approved.ok).toBe(true);
      if (!approved.ok) return;
      expect(approved.value.state).toBe("posted");

      expect(await balanceOf(unappliedAccountId)).toBe(0);
      expect(await zeroSum()).toBe(0);
    });

    it("V14 — end-state: deposits = 0, unapplied = 0 (Q11 closure-eligible); V1 zero-sum holds", async () => {
      expect(await balanceOf(depositsAccountId)).toBe(0);
      expect(await balanceOf(unappliedAccountId)).toBe(0);
      expect(await zeroSum()).toBe(0);
    });

    // ac16-spec §3.7 — extends V14 to actual closure. The sequence above
    // deliberately leaves the BAN's A/R open at 2,000 (8,000 fixture charge −
    // 6,000 allocated) — the guided path's exact step 4 (write off residue)
    // clears it before closure can succeed.
    async function banLastModified(): Promise<Date> {
      const [row] = await sql<{ last_modified: Date }[]>`
        SELECT last_modified FROM billing.billing_account
        WHERE billing_account_id = ${billingAccountId}
      `;
      return row!.last_modified;
    }

    async function faLastModified(): Promise<Date> {
      const [row] = await sql<{ last_modified: Date }[]>`
        SELECT last_modified FROM billing.financial_account
        WHERE financial_account_id = ${financialAccountId}
      `;
      return row!.last_modified;
    }

    it("Customer → CLOSED gate: still has open accounts before closure", async () => {
      expect(await customerHasOpenAccounts(partyRoleId)).toBe(true);
    });

    it("close-BAN blocked while A/R = 2,000 (open) — CLOSURE_BLOCKED", async () => {
      expect(await balanceOf(receivablesAccountId)).toBe(2000);

      const result = await closeBillingAccount(
        { billingAccountId, lastModified: await banLastModified() },
        creatorId,
      );
      expect(result).toEqual({
        ok: false,
        code: "CLOSURE_BLOCKED",
        openReceivable: "2000.00",
      });
    });

    it("close-FA blocked while its BAN is still open — CLOSURE_BLOCKED lists the open BAN", async () => {
      const result = await closeFinancialAccount(
        { financialAccountId, lastModified: await faLastModified() },
        creatorId,
      );
      expect(result).toEqual({
        ok: false,
        code: "CLOSURE_BLOCKED",
        unappliedCash: "0.00",
        deposits: "0.00",
        openBillingAccountIds: [billingAccountId],
      });
    });

    it("write off the 2,000 residue (BAD_DEBT_WRITEOFF, always four-eyes) — A/R → 0", async () => {
      const written = await writeOff(
        {
          financialAccountId,
          billingAccountId,
          amount: "2000.00",
          eventAt: new Date("2026-03-05T00:00:00.000Z"),
          referenceDate: new Date("2026-03-05T00:00:00.000Z"),
          referenceInfo: "V14/ac16 write-off residue",
        },
        creatorId,
      );
      expect(written.ok).toBe(true);
      if (!written.ok) return;
      expect(written.value.state).toBe("pending_approval");

      const selfApprove = await db.transaction((tx) =>
        approveDocument(tx, written.value.documentId, creatorId),
      );
      expect(selfApprove).toEqual({ ok: false, code: "SELF_APPROVAL" });

      const approved = await db.transaction((tx) =>
        approveDocument(tx, written.value.documentId, managerId),
      );
      expect(approved.ok).toBe(true);
      if (!approved.ok) return;
      expect(approved.value.state).toBe("posted");

      expect(await balanceOf(receivablesAccountId)).toBe(0);
      expect(await zeroSum()).toBe(0);
    });

    it("close-BAN succeeds now that A/R = 0", async () => {
      const result = await closeBillingAccount(
        { billingAccountId, lastModified: await banLastModified() },
        creatorId,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toMatchObject({ billingAccountId, state: "closed" });
    });

    it("close-FA succeeds now that unapplied = 0, deposits = 0, and the BAN is closed", async () => {
      const result = await closeFinancialAccount(
        { financialAccountId, lastModified: await faLastModified() },
        creatorId,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toMatchObject({
        financialAccountId,
        state: "closed",
      });
    });

    it("a posting against the now-closed FA is rejected (ACCOUNT_CLOSED) — closure is the last ledger event", async () => {
      const result = await captureDeposit(
        {
          financialAccountId,
          amount: "100.00",
          payment_mode: "cash",
          mode_ref: { receiptNo: "V14-POST-CLOSED" },
          eventAt: new Date("2026-03-06T00:00:00.000Z"),
          referenceDate: new Date("2026-03-06T00:00:00.000Z"),
          referenceInfo: "should be rejected — FA closed",
        },
        creatorId,
      );
      expect(result).toEqual({ ok: false, code: "ACCOUNT_CLOSED" });
      expect(await zeroSum()).toBe(0);
    });

    it("Customer → CLOSED gate: no longer blocked once both FA and BAN are closed", async () => {
      expect(await customerHasOpenAccounts(partyRoleId)).toBe(false);
    });
  },
);
