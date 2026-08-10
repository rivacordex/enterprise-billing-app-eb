import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// ac22-spec §3.5 — SC6. The reversal control renders exactly where
// reverse-document.ts would succeed (inv. #18: eligibility mirrors the
// service, it never replaces it). This test drives one case per branch of the
// eligibility table and asserts, for the SAME fixture, that ac20's `reversible`
// derivation (the control's visibility predicate, produced by
// listTransactionDocuments) equals the reverseDocument service's own outcome.
//
// | Fixture                       | reversible | reverseDocument      |
// |-------------------------------|------------|----------------------|
// | posted, all lines unreversed  | true       | ok                   |
// | posted, some lines reversed   | true       | ok (on remainder)    |
// | posted, all lines reversed    | false      | ALREADY_REVERSED     |
// | draft                         | false      | DOC_STATE_INVALID    |
// | pending_approval              | false      | DOC_STATE_INVALID    |
// | reversed                      | false      | DOC_STATE_INVALID    |
//
// The unifying invariant asserted everywhere: `reversible === result.ok`.

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
import { capturePayment } from "@/services/accounts/capture-payment";
import { onboardCustomerAccounts } from "@/services/accounts/onboard-customer-accounts";
import { raiseDebitNote } from "@/services/accounts/raise-debit-note";
import { reverseDocument } from "@/services/accounts/reverse-document";
import { reverseLine } from "@/services/accounts/reverse-line";
import { listTransactionDocuments } from "@/services/accounts/list-transaction-documents";

const databaseUrl = process.env.DATABASE_URL;
const EVENT_AT = new Date("2026-05-01T00:00:00.000Z");

describe.skipIf(!databaseUrl)(
  "ac22 SC6 — reversal eligibility mirrors the service (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let creatorId: string;
    let financialAccountId: string;
    let billingAccountId: string;

    // The control's visibility predicate — read straight from ac20's producer.
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
        100,
      );
      const row = rows.find((r) => r.documentId === documentId);
      if (!row) {
        throw new Error(`document ${documentId} not found in the listing`);
      }
      return row.reversible;
    }

    async function lastModifiedOf(documentId: string): Promise<Date> {
      const doc = await documentRepository.findById(db, documentId);
      if (!doc) throw new Error(`document ${documentId} not found`);
      return doc.lastModified;
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
        VALUES ('test-ac22-elig-creator', 'AC22 Elig Creator', 'ac22-elig@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id
      `;
      creatorId = creator!.id;

      await sql`SELECT id FROM billing.pgledger_create_account('sys.cash.MYR', 'MYR')`;
      await sql`SELECT id FROM billing.pgledger_create_account('sys.revenue.MYR', 'MYR')`;
      // The DBN tax leg steers to sys.tax_payable.{ccy} (ac09-spec §2.3);
      // the 2-line DBN fixtures below post a tax line, so this must exist.
      await sql`SELECT id FROM billing.pgledger_create_account('sys.tax_payable.MYR', 'MYR')`;
      // The DBN tax leg steers to sys.tax_payable.{ccy} (ac09-spec §2.3);
      // the 2-line DBN fixtures below post a tax line, so this must exist.
      await sql`SELECT id FROM billing.pgledger_create_account('sys.tax_payable.MYR', 'MYR')`;

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
        VALUES ('AC22 Elig Monthly', 'monthly', 1, 30, 'active')
        RETURNING bill_cycle_id AS id
      `;

      const [org] = await sql<{ id: string }[]>`
        INSERT INTO customer.organization (name, organization_type, last_modified_by)
        VALUES ('AC22 Elig Corp', 'COMPANY', ${creatorId})
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
          statusReason: "AC22 eligibility test",
          lastModifiedDatetime: pr!.ts,
        },
        creatorId,
      );
      if (!onboarded.ok)
        throw new Error(`onboarding failed: ${onboarded.code}`);
      financialAccountId = onboarded.value.financialAccountId;
      billingAccountId = onboarded.value.billingAccountId;
    }, 90_000);

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    it("posted, all lines unreversed → shown; service succeeds", async () => {
      const cap = await capturePayment(
        {
          financialAccountId,
          reasonCode: "CUST_PAYMENT",
          amount: "100.00",
          payment_mode: "cash",
          mode_ref: { receiptNo: "ELIG-A" },
          eventAt: EVENT_AT,
          entryDate: EVENT_AT,
          referenceInfo: "elig posted all-unreversed",
        },
        creatorId,
      );
      expect(cap.ok).toBe(true);
      if (!cap.ok) return;
      const docId = cap.value.documentId;

      const reversible = await reversibleOf(docId);
      expect(reversible).toBe(true);

      const result = await reverseDocument(
        {
          originalDocumentId: docId,
          financialAccountId,
          reversalComment: "elig reverse",
          eventAt: EVENT_AT,
          entryDate: EVENT_AT,
          referenceInfo: "elig reverse ref",
          lastModified: await lastModifiedOf(docId),
        },
        creatorId,
      );
      expect(result.ok).toBe(true);
      // inv. #18 — the predicate matched the outcome.
      expect(reversible).toBe(result.ok);
    });

    it("posted, some lines reversed → shown; service succeeds on the remainder", async () => {
      // A real 2-line DBN (charge + tax) so the lines carry ledger transfers.
      const dbn = await raiseDebitNote(
        {
          financialAccountId,
          billingAccountId,
          netAmount: "100.00",
          taxAmount: "6.00",
          eventAt: EVENT_AT,
          entryDate: EVENT_AT,
          referenceInfo: "elig partial DBN",
        },
        creatorId,
      );
      expect(dbn.ok).toBe(true);
      if (!dbn.ok) return;
      const docId = dbn.value.documentId;

      const lines = await documentLineRepository.findByDocumentId(db, docId);
      expect(lines.length).toBe(2);

      // Reverse ONE line (a strict subset) → the doc stays posted.
      const subset = await reverseLine(
        {
          originalDocumentId: docId,
          financialAccountId,
          selectedLineIds: [lines[0]!.documentLineId],
          reversalComment: "elig partial",
          eventAt: EVENT_AT,
          entryDate: EVENT_AT,
          referenceInfo: "elig partial ref",
          lastModified: await lastModifiedOf(docId),
        },
        creatorId,
      );
      expect(subset.ok).toBe(true);
      const stillPosted = await documentRepository.findById(db, docId);
      expect(stillPosted!.state).toBe("posted");

      const reversible = await reversibleOf(docId);
      expect(reversible).toBe(true);

      // Service succeeds on the remainder.
      const result = await reverseDocument(
        {
          originalDocumentId: docId,
          financialAccountId,
          reversalComment: "elig remainder",
          eventAt: EVENT_AT,
          entryDate: EVENT_AT,
          referenceInfo: "elig remainder ref",
          lastModified: await lastModifiedOf(docId),
        },
        creatorId,
      );
      expect(result.ok).toBe(true);
      expect(reversible).toBe(result.ok);
    });

    it("posted, all lines reversed → hidden; service returns ALREADY_REVERSED", async () => {
      // Fabricated: a posted doc whose two lines are both already stamped.
      const doc = await documentRepository.insert(db, "PAY", {
        refFinancialAccountId: financialAccountId,
        refBillingAccountId: null,
        reasonCode: "CUST_PAYMENT",
        currency: "MYR",
        totalAmount: "80.00",
        state: "posted",
        eventAt: EVENT_AT,
        entryDate: EVENT_AT,
        referenceInfo: "elig all-reversed",
        createdBy: creatorId,
        lastEditedBy: creatorId,
      });
      const l1 = await documentLineRepository.insert(db, {
        refDocumentId: doc.documentId,
        lineNo: 1,
        lineKind: "capture",
        amount: "40.00",
        lastEditedBy: creatorId,
      });
      const l2 = await documentLineRepository.insert(db, {
        refDocumentId: doc.documentId,
        lineNo: 2,
        lineKind: "capture",
        amount: "40.00",
        lastEditedBy: creatorId,
      });
      await documentLineRepository.setReversedByLineId(
        db,
        l1.documentLineId,
        l2.documentLineId,
      );
      await documentLineRepository.setReversedByLineId(
        db,
        l2.documentLineId,
        l1.documentLineId,
      );

      const reversible = await reversibleOf(doc.documentId);
      expect(reversible).toBe(false);

      const result = await reverseDocument(
        {
          originalDocumentId: doc.documentId,
          financialAccountId,
          reversalComment: "should fail",
          eventAt: EVENT_AT,
          entryDate: EVENT_AT,
          referenceInfo: "should fail ref",
          lastModified: await lastModifiedOf(doc.documentId),
        },
        creatorId,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("ALREADY_REVERSED");
      expect(reversible).toBe(result.ok);
    });

    it("draft → hidden; service returns DOC_STATE_INVALID", async () => {
      const doc = await documentRepository.insert(db, "DBN", {
        refFinancialAccountId: financialAccountId,
        refBillingAccountId: billingAccountId,
        reasonCode: "MANUAL_CHARGE",
        currency: "MYR",
        totalAmount: "10.00",
        state: "draft",
        eventAt: EVENT_AT,
        entryDate: EVENT_AT,
        referenceInfo: "elig draft",
        createdBy: creatorId,
        lastEditedBy: creatorId,
      });

      const reversible = await reversibleOf(doc.documentId);
      expect(reversible).toBe(false);

      const result = await reverseDocument(
        {
          originalDocumentId: doc.documentId,
          financialAccountId,
          reversalComment: "should fail",
          eventAt: EVENT_AT,
          entryDate: EVENT_AT,
          referenceInfo: "should fail ref",
          lastModified: await lastModifiedOf(doc.documentId),
        },
        creatorId,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("DOC_STATE_INVALID");
      expect(reversible).toBe(result.ok);
    });

    it("pending_approval → hidden; service returns DOC_STATE_INVALID", async () => {
      const doc = await documentRepository.insert(db, "DBN", {
        refFinancialAccountId: financialAccountId,
        refBillingAccountId: billingAccountId,
        reasonCode: "MANUAL_CHARGE",
        currency: "MYR",
        totalAmount: "10.00",
        state: "pending_approval",
        eventAt: EVENT_AT,
        entryDate: EVENT_AT,
        referenceInfo: "elig pending",
        createdBy: creatorId,
        lastEditedBy: creatorId,
      });

      const reversible = await reversibleOf(doc.documentId);
      expect(reversible).toBe(false);

      const result = await reverseDocument(
        {
          originalDocumentId: doc.documentId,
          financialAccountId,
          reversalComment: "should fail",
          eventAt: EVENT_AT,
          entryDate: EVENT_AT,
          referenceInfo: "should fail ref",
          lastModified: await lastModifiedOf(doc.documentId),
        },
        creatorId,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("DOC_STATE_INVALID");
      expect(reversible).toBe(result.ok);
    });

    it("reversed → hidden; service rejects (non-posted state)", async () => {
      const doc = await documentRepository.insert(db, "PAY", {
        refFinancialAccountId: financialAccountId,
        refBillingAccountId: null,
        reasonCode: "CUST_PAYMENT",
        currency: "MYR",
        totalAmount: "30.00",
        state: "reversed",
        eventAt: EVENT_AT,
        entryDate: EVENT_AT,
        referenceInfo: "elig reversed",
        createdBy: creatorId,
        lastEditedBy: creatorId,
      });

      const reversible = await reversibleOf(doc.documentId);
      expect(reversible).toBe(false);

      const result = await reverseDocument(
        {
          originalDocumentId: doc.documentId,
          financialAccountId,
          reversalComment: "should fail",
          eventAt: EVENT_AT,
          entryDate: EVENT_AT,
          referenceInfo: "should fail ref",
          lastModified: await lastModifiedOf(doc.documentId),
        },
        creatorId,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("DOC_STATE_INVALID");
      expect(reversible).toBe(result.ok);
    });
  },
);
