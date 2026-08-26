import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { db } from "@/db/client";
import { documentRepository } from "@/db/repositories/accounts/document.repository";
import { documentLineRepository } from "@/db/repositories/accounts/document-line.repository";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import { onboardCustomerAccounts } from "@/services/accounts/onboard-customer-accounts";
import { getTransactionDocumentDetail } from "@/services/accounts/get-transaction-document-detail";

// ac21-spec §3.5 — integration tests for the document detail service.
// - Detail returns document + lines + legs for a posted multi-line document.
// - A doc belonging to another FA returns WRONG_FINANCIAL_ACCOUNT.
// - A line with a missing transfer resolves to null (em-dash in UI, not a throw).
// - Lines report per-line reversed state correctly on a partially-reversed doc.
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "AC21 — getTransactionDocumentDetail integration (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let creatorId: string;
    let financialAccountId: string;
    let otherFinancialAccountId: string;
    let ban1Id: string;
    let billCycleId: string;
    let partyRoleId: string;

    // Documents created during setup.
    let postedMultiLineDocId: string; // PAY, 2 lines, both have a transfer
    let partiallyReversedDocId: string; // CRN, 2 lines, one reversed
    let partiallyReversedLine1Id: string; // the stamped-reversed line (line 1)
    let otherFaDocId: string; // DEP, belongs to otherFinancialAccountId

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);

      const migrateSql = postgres(databaseUrl as string, { max: 1 });
      await migrateSql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await migrateSql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await migrateSql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await migrateSql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await migrateSql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await migrateSql.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
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
        VALUES ('test-user-ac21-int', 'AC21 Creator', 'ac21-int@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id
      `;
      creatorId = creator!.id;

      await sql`SELECT id FROM billing.pgledger_create_account('sys.cash.MYR', 'MYR')`;
      // A second distinct sys account so the fixture's transfers move between
      // two different accounts (pgledger rejects same-account transfers).
      await sql`SELECT id FROM billing.pgledger_create_account('sys.revenue.MYR', 'MYR')`;

      await sql`
        INSERT INTO billing.reason_code (reason_code, doc_type, posting_nature, auto_post_limit, state)
        VALUES
          ('CUST_PAYMENT',  'PAY', 'cash',        100000.00, 'active'),
          ('BANK_DEPOSIT',  'DEP', 'deposit_movement', 100000.00, 'active'),
          ('BILL_CREDIT',   'CRN', 'revenue_adj',  100000.00, 'active')
      `;

      const [cycle] = await sql<{ id: string }[]>`
        INSERT INTO billing.bill_cycle (name, frequency, cycle_day, payment_due_days, state)
        VALUES ('AC21 Monthly', 'monthly', 1, 30, 'active')
        RETURNING bill_cycle_id AS id
      `;
      billCycleId = cycle!.id;

      const [org] = await sql<{ id: string }[]>`
        INSERT INTO customer.organization (name, organization_type, last_modified_by)
        VALUES ('AC21 Test Corp', 'COMPANY', ${creatorId})
        RETURNING organization_id AS id
      `;
      const [pr] = await sql<{ id: string; ts: Date }[]>`
        INSERT INTO customer.party_role (engaged_party, status, last_modified_by)
        VALUES (${org!.id}, 'INITIALIZED', ${creatorId})
        RETURNING party_role_id AS id, last_modified_datetime AS ts
      `;
      partyRoleId = pr!.id;

      const result = await onboardCustomerAccounts(
        {
          partyRoleId,
          billCycleId,
          currency: "MYR",
          statusReason: "AC21 integration test",
          lastModifiedDatetime: pr!.ts,
        },
        creatorId,
      );
      if (!result.ok) throw new Error(`onboarding failed: ${result.code}`);
      financialAccountId = result.value.financialAccountId;
      ban1Id = result.value.billingAccountId;

      // Second FA for the WRONG_FINANCIAL_ACCOUNT test.
      const [org2] = await sql<{ id: string }[]>`
        INSERT INTO customer.organization (name, organization_type, last_modified_by)
        VALUES ('AC21 Other Corp', 'COMPANY', ${creatorId})
        RETURNING organization_id AS id
      `;
      const [pr2] = await sql<{ id: string; ts: Date }[]>`
        INSERT INTO customer.party_role (engaged_party, status, last_modified_by)
        VALUES (${org2!.id}, 'INITIALIZED', ${creatorId})
        RETURNING party_role_id AS id, last_modified_datetime AS ts
      `;
      const result2 = await onboardCustomerAccounts(
        {
          partyRoleId: pr2!.id,
          billCycleId,
          currency: "MYR",
          statusReason: "AC21 other FA test",
          lastModifiedDatetime: pr2!.ts,
        },
        creatorId,
      );
      if (!result2.ok) throw new Error(`onboarding2 failed: ${result2.code}`);
      otherFinancialAccountId = result2.value.financialAccountId;

      const eventAt = new Date("2026-03-15T00:00:00.000Z");
      const refDate = new Date("2026-03-01T00:00:00.000Z");

      // PAY — 2 lines, both with real pgledger transfers (simulated via direct
      // pgledger_create_transfers so we can assert on the transfer leg data).
      const payDoc = await documentRepository.insert(db, "PAY", {
        refFinancialAccountId: financialAccountId,
        refBillingAccountId: null,
        reasonCode: "CUST_PAYMENT",
        currency: "MYR",
        totalAmount: "1500.00",
        state: "posted",
        eventAt,
        entryDate: refDate,
        referenceInfo: "AC21 multi-line PAY",
        createdBy: creatorId,
        lastEditedBy: creatorId,
      });
      postedMultiLineDocId = payDoc.documentId;

      // Transfer legs reference pgledger accounts by ULID id, not by name, so
      // resolve the two distinct sys-account ids first.
      const [cashRow] = await sql<{ id: string }[]>`
        SELECT id FROM billing.pgledger_accounts_view WHERE name = 'sys.cash.MYR' LIMIT 1
      `;
      const [revenueRow] = await sql<{ id: string }[]>`
        SELECT id FROM billing.pgledger_accounts_view WHERE name = 'sys.revenue.MYR' LIMIT 1
      `;
      const cashId = cashRow!.id;
      const revenueId = revenueRow!.id;

      // Create two real transfers so the legs are resolvable. Dummy accounts —
      // the real posting would use FA accounts, but here we only need the
      // transfer rows to exist so findTransfersByIds resolves them. from ≠ to
      // because pgledger rejects a same-account transfer.
      const transfers = await ledgerRepository.pgledgerCreateTransfers(
        db,
        [
          { fromAccountId: cashId, toAccountId: revenueId, amount: "1000.00" },
          { fromAccountId: revenueId, toAccountId: cashId, amount: "500.00" },
        ],
        eventAt,
        { doc: postedMultiLineDocId },
      );

      const line1 = await documentLineRepository.insert(db, {
        refDocumentId: postedMultiLineDocId,
        lineNo: 1,
        lineKind: "capture",
        amount: "1000.00",
        lastEditedBy: creatorId,
      });
      await documentLineRepository.setTransferId(
        db,
        line1.documentLineId,
        transfers[0]!.id,
      );

      const line2 = await documentLineRepository.insert(db, {
        refDocumentId: postedMultiLineDocId,
        lineNo: 2,
        lineKind: "allocation",
        amount: "500.00",
        refBillingAccountId: ban1Id,
        lastEditedBy: creatorId,
      });
      await documentLineRepository.setTransferId(
        db,
        line2.documentLineId,
        transfers[1]!.id,
      );

      // CRN — 2 lines, line1 reversed, line2 unreversed → partiallyReversed.
      const crnDoc = await documentRepository.insert(db, "CRN", {
        refFinancialAccountId: financialAccountId,
        refBillingAccountId: ban1Id,
        reasonCode: "BILL_CREDIT",
        currency: "MYR",
        totalAmount: "200.00",
        state: "posted",
        eventAt,
        entryDate: refDate,
        referenceInfo: "AC21 partial reversal",
        createdBy: creatorId,
        lastEditedBy: creatorId,
      });
      partiallyReversedDocId = crnDoc.documentId;

      const crnLine1 = await documentLineRepository.insert(db, {
        refDocumentId: partiallyReversedDocId,
        lineNo: 1,
        lineKind: "charge",
        amount: "100.00",
        lastEditedBy: creatorId,
      });
      partiallyReversedLine1Id = crnLine1.documentLineId;
      const crnLine2 = await documentLineRepository.insert(db, {
        refDocumentId: partiallyReversedDocId,
        lineNo: 2,
        lineKind: "charge",
        amount: "100.00",
        lastEditedBy: creatorId,
      });
      // Stamp line1 as reversed (simulate a reversal line pointing back at it).
      await documentLineRepository.setReversedByLineId(
        db,
        crnLine1.documentLineId,
        crnLine2.documentLineId, // reversal line is line2 (for test purposes)
      );

      // DEP doc under the OTHER FA — used for WRONG_FINANCIAL_ACCOUNT test.
      const depDoc = await documentRepository.insert(db, "DEP", {
        refFinancialAccountId: otherFinancialAccountId,
        refBillingAccountId: null,
        reasonCode: "BANK_DEPOSIT",
        currency: "MYR",
        totalAmount: "300.00",
        state: "posted",
        eventAt,
        entryDate: refDate,
        referenceInfo: "AC21 other FA doc",
        createdBy: creatorId,
        lastEditedBy: creatorId,
      });
      otherFaDocId = depDoc.documentId;
    });

    afterAll(async () => {
      await sql.end();
    });

    it("returns document + lines + leg transfers for a posted multi-line document", async () => {
      const result = await getTransactionDocumentDetail(
        postedMultiLineDocId,
        financialAccountId,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const { document: doc, lines } = result.detail;
      expect(doc.documentId).toBe(postedMultiLineDocId);
      expect(doc.state).toBe("posted");
      expect(lines).toHaveLength(2);

      // Both lines have pgledgerTransferId set → transfers must resolve.
      for (const { line, transfer } of lines) {
        expect(line.pgledgerTransferId).not.toBeNull();
        expect(transfer).not.toBeNull();
        if (transfer) {
          expect(transfer.id).toBe(line.pgledgerTransferId);
          expect(typeof transfer.fromAccountName).toBe("string");
          expect(typeof transfer.toAccountName).toBe("string");
          expect(typeof transfer.amount).toBe("string");
        }
      }
    });

    it("WRONG_FINANCIAL_ACCOUNT — a doc from another FA discloses nothing", async () => {
      const result = await getTransactionDocumentDetail(
        otherFaDocId,
        financialAccountId, // wrong FA
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("WRONG_FINANCIAL_ACCOUNT");
      }
    });

    it("DOCUMENT_NOT_FOUND — non-existent document id", async () => {
      const result = await getTransactionDocumentDetail(
        "PAY99999999",
        financialAccountId,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("DOCUMENT_NOT_FOUND");
      }
    });

    it("a line with no pgledgerTransferId resolves to null transfer (em-dash, not a throw)", async () => {
      // The CRN doc lines have no transfers set — pgledgerTransferId is null.
      const result = await getTransactionDocumentDetail(
        partiallyReversedDocId,
        financialAccountId,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      for (const { line, transfer } of result.detail.lines) {
        expect(line.pgledgerTransferId).toBeNull();
        expect(transfer).toBeNull();
      }
    });

    it("reports per-line reversed state correctly on a partially-reversed document", async () => {
      const result = await getTransactionDocumentDetail(
        partiallyReversedDocId,
        financialAccountId,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const { lines, partiallyReversed } = result.detail;
      expect(lines).toHaveLength(2);

      // Only line 1 is stamped as reversed (its reversedByLineId points at
      // line 2); line 2 is the reversal line itself and stays unreversed.
      const reversedLines = lines.filter(
        ({ line }) => line.reversedByLineId !== null,
      );
      const unreversedLines = lines.filter(
        ({ line }) => line.reversedByLineId === null,
      );
      expect(reversedLines).toHaveLength(1);
      expect(reversedLines[0]!.line.documentLineId).toBe(
        partiallyReversedLine1Id,
      );
      expect(unreversedLines).toHaveLength(1);
      expect(partiallyReversed).toBe(true);
    });
  },
);
