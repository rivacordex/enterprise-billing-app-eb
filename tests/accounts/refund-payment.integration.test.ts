import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { db } from "@/db/client";
import { documentRepository } from "@/db/repositories/accounts/document.repository";
import { onboardCustomerAccounts } from "@/services/accounts/onboard-customer-accounts";
import { capturePayment } from "@/services/accounts/capture-payment";
import { allocatePayment } from "@/services/accounts/allocate-payment";
import { getBillingAccountDetail } from "@/services/accounts/get-billing-account-detail";
import { getFinancialAccountDetail } from "@/services/accounts/get-financial-account-detail";
import { approveDocument } from "@/services/accounts/document-state-machine";
import {
  listAssignedItemsForBan,
  refundPayment,
} from "@/services/accounts/refund-payment";

// ac07-spec §3.10 refund-payment.integration.test.ts — the Payment Refund
// workbench (§2.4b): (a) overpayment refund, (b) cash refund of a settled
// payment, (c) convert-to-advance; always four-eyes (reason PAYMENT_REFUND,
// auto_post_limit = 0); refunded amount above original rejected; a
// cross-BAN selection rejected; multi-line total_amount = Σ refunded; V1
// zero-sum after each.
const databaseUrl = process.env.DATABASE_URL;

async function onboard(
  sql: postgresjs.Sql,
  actorId: string,
  cycleId: string,
  orgName: string,
): Promise<{ financialAccountId: string; billingAccountId: string }> {
  const [org] = await sql<{ id: string }[]>`
    INSERT INTO customer.organization (name, organization_type, last_modified_by)
    VALUES (${orgName}, 'COMPANY', ${actorId})
    RETURNING organization_id AS id
  `;
  const [pr] = await sql<{ id: string; ts: Date }[]>`
    INSERT INTO customer.party_role (engaged_party, status, last_modified_by)
    VALUES (${org!.id}, 'INITIALIZED', ${actorId})
    RETURNING party_role_id AS id, last_modified_datetime AS ts
  `;
  const result = await onboardCustomerAccounts(
    {
      partyRoleId: pr!.id,
      billCycleId: cycleId,
      currency: "MYR",
      statusReason: `refund-payment test — ${orgName}`,
      lastModifiedDatetime: pr!.ts,
    },
    actorId,
  );
  if (!result.ok) throw new Error(`onboarding failed: ${result.code}`);
  return {
    financialAccountId: result.value.financialAccountId,
    billingAccountId: result.value.billingAccountId,
  };
}

// A fixture charge (simulating a DBN before ac09 exists, matching
// v03-live-balances' precedent) — gives the BAN a real A/R balance to
// settle, so a reversed allocation has something concrete to "restore".
async function fixtureCharge(
  sql: postgresjs.Sql,
  sysRevenueAccountId: string,
  billingAccountId: string,
  amount: string,
): Promise<void> {
  const [recBinding] = await sql<{ pgledger_account_id: string }[]>`
    SELECT pgledger_account_id FROM billing.ledger_binding
    WHERE owner_type = 'billing_account' AND owner_id = ${billingAccountId} AND ledger_role = 'receivables'
  `;
  await sql`
    SELECT * FROM billing.pgledger_create_transfer(
      ${sysRevenueAccountId}, ${recBinding!.pgledger_account_id}, ${amount}::numeric, NOW(), '{"doc": "refund-fixture-charge"}'::jsonb
    )
  `;
}

describe.skipIf(!databaseUrl)(
  "Payment refund workbench (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let creatorId: string;
    let managerId: string;
    let cycleId: string;
    let sysRevenueAccountId: string;

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

      const [creator] = await sql<{ id: string }[]>`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES ('test-user-refund-creator', 'Refund Creator', 'refund-creator@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id
      `;
      creatorId = creator!.id;
      const [manager] = await sql<{ id: string }[]>`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES ('test-user-refund-manager', 'Refund Manager', 'refund-manager@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id
      `;
      managerId = manager!.id;

      await sql`SELECT id FROM billing.pgledger_create_account('sys.cash.MYR', 'MYR')`;
      const [sysRevenue] = await sql<{ id: string }[]>`
        SELECT id FROM billing.pgledger_create_account('sys.revenue.MYR', 'MYR')
      `;
      sysRevenueAccountId = sysRevenue!.id;

      await sql`
        INSERT INTO billing.reason_code (reason_code, doc_type, posting_nature, auto_post_limit, state)
        VALUES
          ('CUST_PAYMENT', 'PAY', 'cash', 100000.00, 'active'),
          ('ADVANCE_PAYMENT', 'PAY', 'cash', 100000.00, 'active'),
          ('PAYMENT_REFUND', 'PAY', 'cash', 0.00, 'active')
      `;

      const [cycle] = await sql<{ id: string }[]>`
        INSERT INTO billing.bill_cycle (name, frequency, cycle_day, payment_due_days, state)
        VALUES ('Refund Monthly', 'monthly', 1, 30, 'active')
        RETURNING bill_cycle_id AS id
      `;
      cycleId = cycle!.id;
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

    it("(a) overpayment refund: capture with no allocation, refund the unapplied pool — payout leg only, always four-eyes", async () => {
      const { financialAccountId, billingAccountId } = await onboard(
        sql,
        creatorId,
        cycleId,
        "Refund Corp A",
      );

      const captured = await capturePayment(
        {
          financialAccountId,
          reasonCode: "ADVANCE_PAYMENT",
          amount: "1000.00",
          payment_mode: "cash",
          mode_ref: { receiptNo: "REFUND-A-CAPTURE" },
          eventAt: new Date("2026-05-01T00:00:00.000Z"),
          entryDate: new Date("2026-05-01T00:00:00.000Z"),
          referenceInfo: "overpayment capture",
        },
        creatorId,
      );
      expect(captured.ok).toBe(true);

      const refunded = await refundPayment(
        {
          financialAccountId,
          billingAccountId,
          refundType: "cash",
          items: [{ allocationLineId: null, refundedAmount: "1000.00" }],
          eventAt: new Date("2026-05-02T00:00:00.000Z"),
          entryDate: new Date("2026-05-02T00:00:00.000Z"),
          referenceInfo: "overpayment refund",
        },
        creatorId,
      );
      expect(refunded.ok).toBe(true);
      if (!refunded.ok) return;
      // Always four-eyes: auto_post_limit = 0 routes to pending_approval,
      // never a direct USER post.
      expect(refunded.value.state).toBe("pending_approval");

      // Self-approval rejected.
      const selfApproved = await db.transaction((tx) =>
        approveDocument(tx, refunded.value.documentId, creatorId),
      );
      expect(selfApproved).toEqual({ ok: false, code: "SELF_APPROVAL" });

      // A non-creator MANAGER posts it.
      const approved = await db.transaction((tx) =>
        approveDocument(tx, refunded.value.documentId, managerId),
      );
      expect(approved.ok).toBe(true);
      if (!approved.ok) return;
      expect(approved.value.state).toBe("posted");

      const doc = await documentRepository.findById(
        db,
        refunded.value.documentId,
      );
      expect(doc!.totalAmount).toBe("1000.00");

      const faDetail = await getFinancialAccountDetail(financialAccountId);
      expect(faDetail!.unappliedCashBalance).toBe("0.00");
    });

    it("(b) cash refund of a settled payment: reverse + payout, multi-line total_amount = Σ refunded, amount above original rejected", async () => {
      const { financialAccountId, billingAccountId } = await onboard(
        sql,
        creatorId,
        cycleId,
        "Refund Corp B",
      );
      // A fixture A/R charge so the reversed allocation has something real
      // to restore (§2.4b: "the settled document's A/R restored").
      await fixtureCharge(
        sql,
        sysRevenueAccountId,
        billingAccountId,
        "2000.00",
      );

      const captured = await capturePayment(
        {
          financialAccountId,
          reasonCode: "CUST_PAYMENT",
          amount: "2000.00",
          payment_mode: "bank_transfer",
          mode_ref: { bankRef: "REFUND-B-CAPTURE" },
          eventAt: new Date("2026-05-03T00:00:00.000Z"),
          entryDate: new Date("2026-05-03T00:00:00.000Z"),
          referenceInfo: "settled-payment capture",
        },
        creatorId,
      );
      expect(captured.ok).toBe(true);

      const allocated = await allocatePayment(
        {
          financialAccountId,
          billingAccountId,
          amount: "2000.00",
          refSettledDocumentId: null,
          eventAt: new Date("2026-05-04T00:00:00.000Z"),
          entryDate: new Date("2026-05-04T00:00:00.000Z"),
          referenceInfo: "settled-payment allocation",
        },
        creatorId,
      );
      expect(allocated.ok).toBe(true);

      const assignedItems = await listAssignedItemsForBan(billingAccountId);
      expect(assignedItems).toHaveLength(1);
      const item = assignedItems[0]!;

      // Refunding above the original assigned amount is rejected.
      const tooMuch = await refundPayment(
        {
          financialAccountId,
          billingAccountId,
          refundType: "cash",
          items: [
            {
              allocationLineId: item.allocationLineId,
              refundedAmount: "2000.01",
            },
          ],
          eventAt: new Date("2026-05-05T00:00:00.000Z"),
          entryDate: new Date("2026-05-05T00:00:00.000Z"),
          referenceInfo: "over-refund attempt",
        },
        creatorId,
      );
      expect(tooMuch).toEqual({ ok: false, code: "AMOUNT_EXCEEDS_ORIGINAL" });

      const refunded = await refundPayment(
        {
          financialAccountId,
          billingAccountId,
          refundType: "cash",
          items: [
            {
              allocationLineId: item.allocationLineId,
              refundedAmount: "2000.00",
            },
          ],
          eventAt: new Date("2026-05-05T00:00:00.000Z"),
          entryDate: new Date("2026-05-05T00:00:00.000Z"),
          referenceInfo: "settled-payment cash refund",
        },
        creatorId,
      );
      expect(refunded.ok).toBe(true);
      if (!refunded.ok) return;
      expect(refunded.value.state).toBe("pending_approval");

      const approved = await db.transaction((tx) =>
        approveDocument(tx, refunded.value.documentId, managerId),
      );
      expect(approved.ok).toBe(true);
      if (!approved.ok) return;

      // Two lines (release + payout), 2000.00 each — total_amount = Σ lines
      // (§2.8: the header is derived from the actual GL movement, not the
      // per-item "refunded amount" the operator sees).
      const doc = await documentRepository.findById(
        db,
        refunded.value.documentId,
      );
      expect(doc!.totalAmount).toBe("4000.00");

      // Net: A/R restored, cash paid out.
      const banDetail = await getBillingAccountDetail(billingAccountId);
      expect(banDetail!.receivableBalance).toBe("2000.00");
      const faDetail = await getFinancialAccountDetail(financialAccountId);
      expect(faDetail!.unappliedCashBalance).toBe("0.00");

      // Refunding the same application again is rejected.
      const again = await refundPayment(
        {
          financialAccountId,
          billingAccountId,
          refundType: "cash",
          items: [
            {
              allocationLineId: item.allocationLineId,
              refundedAmount: "100.00",
            },
          ],
          eventAt: new Date("2026-05-06T00:00:00.000Z"),
          entryDate: new Date("2026-05-06T00:00:00.000Z"),
          referenceInfo: "double-refund attempt",
        },
        creatorId,
      );
      expect(again).toEqual({ ok: false, code: "ALREADY_REFUNDED" });
    });

    it("(c) convert to advance: reverse only, A/R restored, unapplied advance, no payout leg", async () => {
      const { financialAccountId, billingAccountId } = await onboard(
        sql,
        creatorId,
        cycleId,
        "Refund Corp C",
      );
      await fixtureCharge(
        sql,
        sysRevenueAccountId,
        billingAccountId,
        "1500.00",
      );

      const captured = await capturePayment(
        {
          financialAccountId,
          reasonCode: "CUST_PAYMENT",
          amount: "1500.00",
          payment_mode: "cheque",
          mode_ref: { chequeNo: "REFUND-C-001", bank: "Test Bank" },
          eventAt: new Date("2026-05-07T00:00:00.000Z"),
          entryDate: new Date("2026-05-07T00:00:00.000Z"),
          referenceInfo: "convert-to-advance capture",
        },
        creatorId,
      );
      expect(captured.ok).toBe(true);

      const allocated = await allocatePayment(
        {
          financialAccountId,
          billingAccountId,
          amount: "1500.00",
          refSettledDocumentId: null,
          eventAt: new Date("2026-05-08T00:00:00.000Z"),
          entryDate: new Date("2026-05-08T00:00:00.000Z"),
          referenceInfo: "convert-to-advance allocation",
        },
        creatorId,
      );
      expect(allocated.ok).toBe(true);

      const assignedItems = await listAssignedItemsForBan(billingAccountId);
      const item = assignedItems[0]!;

      const refunded = await refundPayment(
        {
          financialAccountId,
          billingAccountId,
          refundType: "convert_to_advance",
          items: [
            {
              allocationLineId: item.allocationLineId,
              refundedAmount: "1500.00",
            },
          ],
          eventAt: new Date("2026-05-09T00:00:00.000Z"),
          entryDate: new Date("2026-05-09T00:00:00.000Z"),
          referenceInfo: "convert to advance",
        },
        creatorId,
      );
      expect(refunded.ok).toBe(true);
      if (!refunded.ok) return;
      expect(refunded.value.state).toBe("pending_approval");

      const approved = await db.transaction((tx) =>
        approveDocument(tx, refunded.value.documentId, managerId),
      );
      expect(approved.ok).toBe(true);
      if (!approved.ok) return;

      const doc = await documentRepository.findById(
        db,
        refunded.value.documentId,
      );
      expect(doc!.totalAmount).toBe("1500.00"); // reversal line only, no payout

      const banDetail = await getBillingAccountDetail(billingAccountId);
      expect(banDetail!.receivableBalance).toBe("1500.00");
      const faDetail = await getFinancialAccountDetail(financialAccountId);
      // Advance credit sitting in unapplied_cash — held, no cash left the FA.
      expect(faDetail!.unappliedCashBalance).toBe("-1500.00");
    });

    it("a cross-BAN item selection is rejected", async () => {
      const custX = await onboard(sql, creatorId, cycleId, "Refund Corp X");
      const custY = await onboard(sql, creatorId, cycleId, "Refund Corp Y BAN");

      const captured = await capturePayment(
        {
          financialAccountId: custX.financialAccountId,
          reasonCode: "CUST_PAYMENT",
          amount: "300.00",
          payment_mode: "cash",
          mode_ref: { receiptNo: "REFUND-X-CAPTURE" },
          eventAt: new Date("2026-05-10T00:00:00.000Z"),
          entryDate: new Date("2026-05-10T00:00:00.000Z"),
          referenceInfo: "cross-BAN capture",
        },
        creatorId,
      );
      expect(captured.ok).toBe(true);

      const allocated = await allocatePayment(
        {
          financialAccountId: custX.financialAccountId,
          billingAccountId: custX.billingAccountId,
          amount: "300.00",
          refSettledDocumentId: null,
          eventAt: new Date("2026-05-11T00:00:00.000Z"),
          entryDate: new Date("2026-05-11T00:00:00.000Z"),
          referenceInfo: "cross-BAN allocation",
        },
        creatorId,
      );
      expect(allocated.ok).toBe(true);

      const assignedItems = await listAssignedItemsForBan(
        custX.billingAccountId,
      );
      const item = assignedItems[0]!;

      // Selecting custX's application while scoping the refund to custY's BAN.
      const result = await refundPayment(
        {
          financialAccountId: custY.financialAccountId,
          billingAccountId: custY.billingAccountId,
          refundType: "cash",
          items: [
            {
              allocationLineId: item.allocationLineId,
              refundedAmount: "300.00",
            },
          ],
          eventAt: new Date("2026-05-12T00:00:00.000Z"),
          entryDate: new Date("2026-05-12T00:00:00.000Z"),
          referenceInfo: "cross-BAN refund attempt",
        },
        creatorId,
      );
      expect(result).toEqual({ ok: false, code: "BILLING_ACCOUNT_NOT_FOUND" });
    });

    it("V1 — zero-sum holds after every refund scenario in this suite", async () => {
      const [sumRow] = await sql<{ total: string | null }[]>`
        SELECT sum(balance)::text AS total FROM billing.pgledger_accounts_view
      `;
      expect(Number(sumRow?.total ?? "0")).toBe(0);
    });
  },
);
