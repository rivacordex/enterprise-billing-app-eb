import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// ac22-spec §3.5 — SC7 + SC8. The dialog's line checkboxes select between the
// two shipped services via `selectedLineIds`:
//   • all unreversed lines checked → omitted → reverseDocument → original
//     flips to `reversed`;
//   • a strict subset → sent → reverseLine → original stays `posted` with a
//     reduced remainder that is still reversible.
// SC8: reversing a PAY allocation line returns funds to unapplied_cash while
// the bank capture stays posted. V1 zero-sum is asserted after every posting.

vi.mock("@/db/client", async (importOriginal) => {
  if (!process.env.DATABASE_URL) return { db: {} };
  return importOriginal();
});
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { db } from "@/db/client";
import { documentRepository } from "@/db/repositories/accounts/document.repository";
import { documentLineRepository } from "@/db/repositories/accounts/document-line.repository";
import { allocatePayment } from "@/services/accounts/allocate-payment";
import { capturePayment } from "@/services/accounts/capture-payment";
import { onboardCustomerAccounts } from "@/services/accounts/onboard-customer-accounts";
import { raiseDebitNote } from "@/services/accounts/raise-debit-note";
import { reverseDocument } from "@/services/accounts/reverse-document";
import { reverseLine } from "@/services/accounts/reverse-line";
import { listTransactionDocuments } from "@/services/accounts/list-transaction-documents";

const databaseUrl = process.env.DATABASE_URL;
const EVENT_AT = new Date("2026-06-01T00:00:00.000Z");

describe.skipIf(!databaseUrl)(
  "ac22 SC7/SC8 — line selection unifies reverseDocument and reverseLine (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let creatorId: string;
    let financialAccountId: string;
    let billingAccountId: string;
    let unappliedAccountId: string;
    let receivablesAccountId: string;

    async function balanceOf(accountId: string): Promise<number> {
      const [row] = await sql<{ balance: string }[]>`
        SELECT balance::text AS balance
        FROM billing.pgledger_accounts_view
        WHERE id = ${accountId}
      `;
      return Number(row?.balance ?? "0");
    }

    async function zeroSum(): Promise<number> {
      const [row] = await sql<{ total: string | null }[]>`
        SELECT sum(balance)::text AS total FROM billing.pgledger_accounts_view
      `;
      return Number(row?.total ?? "0");
    }

    async function lastModifiedOf(documentId: string): Promise<Date> {
      const doc = await documentRepository.findById(db, documentId);
      if (!doc) throw new Error(`document ${documentId} not found`);
      return doc.lastModified;
    }

    async function reversibleOf(documentId: string): Promise<boolean> {
      const { rows } = await listTransactionDocuments(
        financialAccountId,
        null,
        {
          type: null,
          status: null,
          rev: null,
          q: "",
          sort: "-event_at",
          page: 1,
        },
        200,
      );
      return rows.find((r) => r.documentId === documentId)?.reversible ?? false;
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

      const [creator] = await sql<{ id: string }[]>`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES ('test-ac22-linesel-creator', 'AC22 LineSel Creator', 'ac22-linesel@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id
      `;
      creatorId = creator!.id;

      await sql`SELECT id FROM billing.pgledger_create_account('sys.cash.MYR', 'MYR')`;
      await sql`SELECT id FROM billing.pgledger_create_account('sys.revenue.MYR', 'MYR')`;

      await sql`
        INSERT INTO billing.gl_account (gl_code, name, account_class, normal_balance, is_postable)
        VALUES ('1100', 'Cash', 'asset', 'debit', true),
               ('4000', 'Revenue', 'revenue', 'credit', true)
      `;
      await sql`
        INSERT INTO billing.gl_mapping (selector_type, selector, currency, ref_gl_code)
        VALUES ('system_account', 'sys.cash.MYR',    'MYR', '1100'),
               ('system_account', 'sys.revenue.MYR', 'MYR', '4000')
      `;

      await sql`
        INSERT INTO billing.reason_code (reason_code, doc_type, posting_nature, auto_post_limit, state)
        VALUES
          ('CUST_PAYMENT',  'PAY', 'cash',    100000.00, 'active'),
          ('MANUAL_CHARGE', 'DBN', 'revenue', 100000.00, 'active')
      `;

      const [cycle] = await sql<{ id: string }[]>`
        INSERT INTO billing.bill_cycle (name, frequency, cycle_day, payment_due_days, state)
        VALUES ('AC22 LineSel Monthly', 'monthly', 1, 30, 'active')
        RETURNING bill_cycle_id AS id
      `;

      const [org] = await sql<{ id: string }[]>`
        INSERT INTO customer.organization (name, organization_type, last_modified_by)
        VALUES ('AC22 LineSel Corp', 'COMPANY', ${creatorId})
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
          statusReason: "AC22 line-selection test",
          lastModifiedDatetime: pr!.ts,
        },
        creatorId,
      );
      if (!onboarded.ok)
        throw new Error(`onboarding failed: ${onboarded.code}`);
      financialAccountId = onboarded.value.financialAccountId;
      billingAccountId = onboarded.value.billingAccountId;

      const [recRow] = await sql<{ pgledger_account_id: string }[]>`
        SELECT pgledger_account_id FROM billing.ledger_binding
        WHERE owner_type = 'billing_account' AND owner_id = ${billingAccountId} AND ledger_role = 'receivables'
      `;
      receivablesAccountId = recRow!.pgledger_account_id;

      const [ucRow] = await sql<{ pgledger_account_id: string }[]>`
        SELECT pgledger_account_id FROM billing.ledger_binding
        WHERE owner_type = 'financial_account' AND owner_id = ${financialAccountId} AND ledger_role = 'unapplied_cash'
      `;
      unappliedAccountId = ucRow!.pgledger_account_id;
    }, 90_000);

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    it("SC7: all lines checked → reverseDocument → original flips to 'reversed'", async () => {
      // Real 2-line DBN (charge + tax).
      const dbn = await raiseDebitNote(
        {
          financialAccountId,
          billingAccountId,
          netAmount: "100.00",
          taxAmount: "6.00",
          eventAt: EVENT_AT,
          referenceDate: EVENT_AT,
          referenceInfo: "SC7 full DBN",
        },
        creatorId,
      );
      expect(dbn.ok).toBe(true);
      if (!dbn.ok) return;
      const docId = dbn.value.documentId;
      expect(await zeroSum()).toBeCloseTo(0, 6);

      const lines = await documentLineRepository.findByDocumentId(db, docId);
      expect(lines.length).toBe(2);

      // "All checked" → the dialog omits selectedLineIds → reverseDocument.
      const rev = await reverseDocument(
        {
          originalDocumentId: docId,
          financialAccountId,
          reversalComment: "SC7 full reversal",
          eventAt: EVENT_AT,
          referenceDate: EVENT_AT,
          referenceInfo: "SC7 full reversal ref",
          lastModified: await lastModifiedOf(docId),
        },
        creatorId,
      );
      expect(rev.ok).toBe(true);

      const updated = await documentRepository.findById(db, docId);
      expect(updated!.state).toBe("reversed");
      const updatedLines = await documentLineRepository.findByDocumentId(
        db,
        docId,
      );
      for (const line of updatedLines) {
        expect(line.reversedByLineId).not.toBeNull();
      }
      expect(await reversibleOf(docId)).toBe(false);
      expect(await zeroSum()).toBeCloseTo(0, 6);
    });

    it("SC7: subset → reverseLine → original stays 'posted'; remainder still reversible; second reversal flips it to 'reversed'", async () => {
      const dbn = await raiseDebitNote(
        {
          financialAccountId,
          billingAccountId,
          netAmount: "200.00",
          taxAmount: "12.00",
          eventAt: EVENT_AT,
          referenceDate: EVENT_AT,
          referenceInfo: "SC7 subset DBN",
        },
        creatorId,
      );
      expect(dbn.ok).toBe(true);
      if (!dbn.ok) return;
      const docId = dbn.value.documentId;
      const lines = await documentLineRepository.findByDocumentId(db, docId);
      expect(lines.length).toBe(2);

      // Subset (line 1 only) → selectedLineIds sent → reverseLine.
      const subset = await reverseLine(
        {
          originalDocumentId: docId,
          financialAccountId,
          selectedLineIds: [lines[0]!.documentLineId],
          reversalComment: "SC7 subset reversal",
          eventAt: EVENT_AT,
          referenceDate: EVENT_AT,
          referenceInfo: "SC7 subset ref",
          lastModified: await lastModifiedOf(docId),
        },
        creatorId,
      );
      expect(subset.ok).toBe(true);

      const afterSubset = await documentRepository.findById(db, docId);
      expect(afterSubset!.state).toBe("posted");
      // The remainder is still reversible.
      expect(await reversibleOf(docId)).toBe(true);
      expect(await zeroSum()).toBeCloseTo(0, 6);

      // Reverse the remaining line → doc flips to 'reversed'.
      const remainingLines = await documentLineRepository.findByDocumentId(
        db,
        docId,
      );
      const remaining = remainingLines.find((l) => l.reversedByLineId === null);
      expect(remaining).toBeDefined();
      const second = await reverseLine(
        {
          originalDocumentId: docId,
          financialAccountId,
          selectedLineIds: [remaining!.documentLineId],
          reversalComment: "SC7 remainder reversal",
          eventAt: EVENT_AT,
          referenceDate: EVENT_AT,
          referenceInfo: "SC7 remainder ref",
          lastModified: await lastModifiedOf(docId),
        },
        creatorId,
      );
      expect(second.ok).toBe(true);

      const afterSecond = await documentRepository.findById(db, docId);
      expect(afterSecond!.state).toBe("reversed");
      expect(await reversibleOf(docId)).toBe(false);
      expect(await zeroSum()).toBeCloseTo(0, 6);
    });

    it("SC8: reversing a PAY allocation line returns funds to unapplied_cash while the capture stays posted", async () => {
      // Charge A/R (1500), capture (1500 → unapplied), allocate (unapplied → A/R).
      const dbn = await raiseDebitNote(
        {
          financialAccountId,
          billingAccountId,
          netAmount: "1500.00",
          taxAmount: null,
          eventAt: EVENT_AT,
          referenceDate: EVENT_AT,
          referenceInfo: "SC8 charge",
        },
        creatorId,
      );
      expect(dbn.ok).toBe(true);
      expect(await zeroSum()).toBeCloseTo(0, 6);

      const cap = await capturePayment(
        {
          financialAccountId,
          reasonCode: "CUST_PAYMENT",
          amount: "1500.00",
          payment_mode: "bank_transfer",
          mode_ref: { bankRef: "SC8-CAP" },
          eventAt: EVENT_AT,
          referenceDate: EVENT_AT,
          referenceInfo: "SC8 capture",
        },
        creatorId,
      );
      expect(cap.ok).toBe(true);
      if (!cap.ok) return;
      const captureDocId = cap.value.documentId;
      expect(await balanceOf(unappliedAccountId)).toBeCloseTo(-1500, 2);
      expect(await zeroSum()).toBeCloseTo(0, 6);

      const alloc = await allocatePayment(
        {
          financialAccountId,
          billingAccountId,
          amount: "1500.00",
          refSettledDocumentId: null,
          eventAt: EVENT_AT,
          referenceDate: EVENT_AT,
          referenceInfo: "SC8 allocate",
        },
        creatorId,
      );
      expect(alloc.ok).toBe(true);
      if (!alloc.ok) return;
      const allocDocId = alloc.value.documentId;
      // After allocation, unapplied is back to 0 (funds applied to A/R).
      expect(await balanceOf(unappliedAccountId)).toBeCloseTo(0, 2);
      expect(await balanceOf(receivablesAccountId)).toBeCloseTo(0, 2);
      expect(await zeroSum()).toBeCloseTo(0, 6);

      // Reverse the single allocation line (all-checked → reverseDocument path,
      // but the doc has one line so it also demonstrates the allocation reversal
      // returning funds to unapplied cash — SC8).
      const allocLines = await documentLineRepository.findByDocumentId(
        db,
        allocDocId,
      );
      expect(allocLines).toHaveLength(1);
      expect(allocLines[0]!.lineKind).toBe("allocation");

      const rev = await reverseLine(
        {
          originalDocumentId: allocDocId,
          financialAccountId,
          selectedLineIds: [allocLines[0]!.documentLineId],
          reversalComment: "SC8 allocation reversal",
          eventAt: EVENT_AT,
          referenceDate: EVENT_AT,
          referenceInfo: "SC8 allocation reversal ref",
          lastModified: await lastModifiedOf(allocDocId),
        },
        creatorId,
      );
      expect(rev.ok).toBe(true);

      // Funds returned to unapplied cash; A/R restored to the charged amount.
      expect(await balanceOf(unappliedAccountId)).toBeCloseTo(-1500, 2);
      expect(await balanceOf(receivablesAccountId)).toBeCloseTo(1500, 2);

      // The bank capture document is untouched — still posted, line unreversed.
      const captureDoc = await documentRepository.findById(db, captureDocId);
      expect(captureDoc!.state).toBe("posted");
      const captureLines = await documentLineRepository.findByDocumentId(
        db,
        captureDocId,
      );
      expect(captureLines[0]!.reversedByLineId).toBeNull();
      expect(captureLines[0]!.pgledgerTransferId).not.toBeNull();

      // V1 zero-sum holds after the reversal.
      expect(await zeroSum()).toBeCloseTo(0, 6);
    });

    it("stale lastModified → CONFLICT", async () => {
      const cap = await capturePayment(
        {
          financialAccountId,
          reasonCode: "CUST_PAYMENT",
          amount: "50.00",
          payment_mode: "cash",
          mode_ref: { receiptNo: "SC7-CONFLICT" },
          eventAt: EVENT_AT,
          referenceDate: EVENT_AT,
          referenceInfo: "SC7 conflict capture",
        },
        creatorId,
      );
      expect(cap.ok).toBe(true);
      if (!cap.ok) return;

      const result = await reverseDocument(
        {
          originalDocumentId: cap.value.documentId,
          financialAccountId,
          reversalComment: "stale reversal",
          eventAt: EVENT_AT,
          referenceDate: EVENT_AT,
          referenceInfo: "stale reversal ref",
          // Deliberately stale — not the document's current lastModified.
          lastModified: new Date("2000-01-01T00:00:00.000Z"),
        },
        creatorId,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("CONFLICT");
      expect(await zeroSum()).toBeCloseTo(0, 6);
    });
  },
);
