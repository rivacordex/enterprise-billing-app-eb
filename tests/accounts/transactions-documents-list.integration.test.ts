import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { db } from "@/db/client";
import { documentRepository } from "@/db/repositories/accounts/document.repository";
import { documentLineRepository } from "@/db/repositories/accounts/document-line.repository";
import { onboardCustomerAccounts } from "@/services/accounts/onboard-customer-accounts";
import { listTransactionDocuments } from "@/services/accounts/list-transaction-documents";
import { DOC_TYPES } from "@/types/accounts";

// ac20-spec §3.7 — integration tests for the document list service.
// SC4: PAY/DEP captures (refBillingAccountId IS NULL) appear when FA+BAN selected.
// SC5: doc against a different BAN does not appear in results for BAN1.
// FA-wide scope (no BAN) admits all docs for the FA.
// Aggregate: partiallyReversed/reversible derivation via line counts.
// Filter composition, sort whitelist fallback, pagination total, inv. #19.
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "AC20 — listTransactionDocuments integration (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let creatorId: string;
    let financialAccountId: string;
    let ban1Id: string;
    let ban2Id: string;
    let billCycleId: string;
    let partyRoleId: string;

    // Document IDs set during setup for targeted lookup in tests.
    let payCapture1Id: string; // PAY, null BAN, state=posted, 1 line (unreversed)
    let depCapture1Id: string; // DEP, null BAN, state=posted, 1 line (unreversed)
    let crn1Id: string; // CRN, BAN1, state=posted, 2 lines (1 reversed → partiallyReversed)
    let crn2Id: string; // CRN, BAN1, state=posted, 2 lines (both reversed → not reversible)
    let crn3Id: string; // CRN, BAN2 (SC5 — different BAN, should not appear for BAN1)
    let dbn1Id: string; // DBN, BAN1, state=draft

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
        VALUES ('test-user-ac20-int-creator', 'AC20 Creator', 'ac20-int-creator@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id
      `;
      creatorId = creator!.id;

      await sql`SELECT id FROM billing.pgledger_create_account('sys.cash.MYR', 'MYR')`;

      await sql`
        INSERT INTO billing.reason_code (reason_code, doc_type, posting_nature, auto_post_limit, state)
        VALUES
          ('CUST_PAYMENT',   'PAY', 'cash',           100000.00, 'active'),
          ('BANK_DEPOSIT',   'DEP', 'deposit_movement',100000.00, 'active'),
          ('BILL_CREDIT',    'CRN', 'revenue_adj',     100000.00, 'active'),
          ('BILL_DEBIT',     'DBN', 'revenue_adj',     100000.00, 'active'),
          ('ROUNDING_ADJ',   'ADJ', 'revenue_adj',     100000.00, 'active')
      `;

      const [cycle] = await sql<{ id: string }[]>`
        INSERT INTO billing.bill_cycle (name, frequency, cycle_day, payment_due_days, state)
        VALUES ('AC20 Monthly', 'monthly', 1, 30, 'active')
        RETURNING bill_cycle_id AS id
      `;
      billCycleId = cycle!.id;

      const [org] = await sql<{ id: string }[]>`
        INSERT INTO customer.organization (name, organization_type, last_modified_by)
        VALUES ('AC20 Test Corp', 'COMPANY', ${creatorId})
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
          statusReason: "AC20 integration test",
          lastModifiedDatetime: pr!.ts,
        },
        creatorId,
      );
      if (!result.ok) throw new Error(`onboarding failed: ${result.code}`);
      financialAccountId = result.value.financialAccountId;
      ban1Id = result.value.billingAccountId;

      // BAN2 — used by SC5 to verify that docs scoped to a different BAN are excluded.
      const [ban2] = await sql<{ id: string }[]>`
        INSERT INTO billing.billing_account
          (name, ref_party_role_id, ref_financial_account_id, currency, ref_bill_cycle_id, last_edited_by)
        VALUES
          ('AC20 BAN2', ${partyRoleId}, ${financialAccountId}, 'MYR', ${billCycleId}, ${creatorId})
        RETURNING billing_account_id AS id
      `;
      ban2Id = ban2!.id;

      // Shared event date — all documents in the same month for simplicity.
      const eventAt = new Date("2026-03-15T00:00:00.000Z");
      const refDate = new Date("2026-03-01T00:00:00.000Z");

      // PAY capture (null BAN) — SC4 trap: FA-level doc must appear when BAN1 selected.
      const payDoc = await documentRepository.insert(db, "PAY", {
        refFinancialAccountId: financialAccountId,
        refBillingAccountId: null,
        reasonCode: "CUST_PAYMENT",
        currency: "MYR",
        totalAmount: "1000.00",
        state: "posted",
        eventAt,
        entryDate: refDate,
        referenceInfo: "AC20 PAY capture",
        createdBy: creatorId,
        lastEditedBy: creatorId,
      });
      payCapture1Id = payDoc.documentId;
      // One unreversed line (reversedByLineId IS NULL).
      await documentLineRepository.insert(db, {
        refDocumentId: payCapture1Id,
        lineNo: 1,
        lineKind: "capture",
        amount: "1000.00",
        lastEditedBy: creatorId,
      });

      // DEP capture (null BAN) — SC4, DEP type.
      const depDoc = await documentRepository.insert(db, "DEP", {
        refFinancialAccountId: financialAccountId,
        refBillingAccountId: null,
        reasonCode: "BANK_DEPOSIT",
        currency: "MYR",
        totalAmount: "500.00",
        state: "posted",
        eventAt,
        entryDate: refDate,
        referenceInfo: "AC20 DEP capture",
        createdBy: creatorId,
        lastEditedBy: creatorId,
      });
      depCapture1Id = depDoc.documentId;
      await documentLineRepository.insert(db, {
        refDocumentId: depCapture1Id,
        lineNo: 1,
        lineKind: "capture",
        amount: "500.00",
        lastEditedBy: creatorId,
      });

      // CRN1 — BAN1, 2 lines: one reversed (partially reversed → partiallyReversed=true, reversible=true).
      const crn1Doc = await documentRepository.insert(db, "CRN", {
        refFinancialAccountId: financialAccountId,
        refBillingAccountId: ban1Id,
        reasonCode: "BILL_CREDIT",
        currency: "MYR",
        totalAmount: "200.00",
        state: "posted",
        eventAt,
        entryDate: refDate,
        referenceInfo: "AC20 CRN partial reversal",
        createdBy: creatorId,
        lastEditedBy: creatorId,
      });
      crn1Id = crn1Doc.documentId;
      // Original line.
      const crn1Line1 = await documentLineRepository.insert(db, {
        refDocumentId: crn1Id,
        lineNo: 1,
        lineKind: "charge",
        amount: "100.00",
        lastEditedBy: creatorId,
      });
      // Reversal line (no reversedByLineId of its own — it is the reversal).
      const crn1Line2 = await documentLineRepository.insert(db, {
        refDocumentId: crn1Id,
        lineNo: 2,
        lineKind: "charge",
        amount: "100.00",
        lastEditedBy: creatorId,
      });
      // Mark line1 as reversed by line2.
      await documentLineRepository.setReversedByLineId(
        db,
        crn1Line1.documentLineId,
        crn1Line2.documentLineId,
      );

      // CRN2 — BAN1, 2 lines: both reversed → partiallyReversed=false, reversible=false.
      const crn2Doc = await documentRepository.insert(db, "CRN", {
        refFinancialAccountId: financialAccountId,
        refBillingAccountId: ban1Id,
        reasonCode: "BILL_CREDIT",
        currency: "MYR",
        totalAmount: "300.00",
        state: "posted",
        eventAt: new Date("2026-03-10T00:00:00.000Z"),
        entryDate: refDate,
        referenceInfo: "AC20 CRN fully reversed",
        createdBy: creatorId,
        lastEditedBy: creatorId,
      });
      crn2Id = crn2Doc.documentId;
      const crn2Line1 = await documentLineRepository.insert(db, {
        refDocumentId: crn2Id,
        lineNo: 1,
        lineKind: "charge",
        amount: "150.00",
        lastEditedBy: creatorId,
      });
      const crn2Line2 = await documentLineRepository.insert(db, {
        refDocumentId: crn2Id,
        lineNo: 2,
        lineKind: "charge",
        amount: "150.00",
        lastEditedBy: creatorId,
      });
      // Mark both lines as reversed (each reversed by the other — valid FK, realistic).
      await documentLineRepository.setReversedByLineId(
        db,
        crn2Line1.documentLineId,
        crn2Line2.documentLineId,
      );
      await documentLineRepository.setReversedByLineId(
        db,
        crn2Line2.documentLineId,
        crn2Line1.documentLineId,
      );

      // CRN3 — BAN2 (SC5 — must NOT appear when querying FA+BAN1).
      const crn3Doc = await documentRepository.insert(db, "CRN", {
        refFinancialAccountId: financialAccountId,
        refBillingAccountId: ban2Id,
        reasonCode: "BILL_CREDIT",
        currency: "MYR",
        totalAmount: "400.00",
        state: "posted",
        eventAt,
        entryDate: refDate,
        referenceInfo: "AC20 CRN BAN2 (SC5)",
        createdBy: creatorId,
        lastEditedBy: creatorId,
      });
      crn3Id = crn3Doc.documentId;

      // DBN1 — BAN1, draft state (tests type and status filters; not reversible).
      const dbn1Doc = await documentRepository.insert(db, "DBN", {
        refFinancialAccountId: financialAccountId,
        refBillingAccountId: ban1Id,
        reasonCode: "BILL_DEBIT",
        currency: "MYR",
        totalAmount: "50.00",
        state: "draft",
        eventAt,
        entryDate: refDate,
        referenceInfo: "AC20 DBN draft",
        createdBy: creatorId,
        lastEditedBy: creatorId,
      });
      dbn1Id = dbn1Doc.documentId;
    }, 90_000);

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    // ── SC4 — FA-level captures appear when BAN is selected ───────────────────

    it("SC4: PAY capture (refBillingAccountId=null) appears when FA+BAN1 selected", async () => {
      const { rows } = await listTransactionDocuments(
        financialAccountId,
        ban1Id,
        {
          type: null,
          status: null,
          rev: null,
          q: "",
          sort: "-event_at",
          page: 1,
        },
        50,
      );
      const ids = rows.map((r) => r.documentId);
      expect(ids).toContain(payCapture1Id);
    });

    it("SC4: DEP capture (refBillingAccountId=null) appears when FA+BAN1 selected", async () => {
      const { rows } = await listTransactionDocuments(
        financialAccountId,
        ban1Id,
        {
          type: null,
          status: null,
          rev: null,
          q: "",
          sort: "-event_at",
          page: 1,
        },
        50,
      );
      const ids = rows.map((r) => r.documentId);
      expect(ids).toContain(depCapture1Id);
    });

    // ── SC5 — different-BAN doc excluded ──────────────────────────────────────

    it("SC5: CRN against BAN2 does not appear in FA+BAN1 results", async () => {
      const { rows } = await listTransactionDocuments(
        financialAccountId,
        ban1Id,
        {
          type: null,
          status: null,
          rev: null,
          q: "",
          sort: "-event_at",
          page: 1,
        },
        50,
      );
      const ids = rows.map((r) => r.documentId);
      expect(ids).not.toContain(crn3Id);
    });

    // ── FA-wide scope (no BAN) ────────────────────────────────────────────────

    it("FA-wide (no BAN): returns all docs for the FA including BAN2 doc", async () => {
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
        50,
      );
      const ids = rows.map((r) => r.documentId);
      expect(ids).toContain(payCapture1Id);
      expect(ids).toContain(depCapture1Id);
      expect(ids).toContain(crn1Id);
      expect(ids).toContain(crn2Id);
      expect(ids).toContain(crn3Id);
      expect(ids).toContain(dbn1Id);
    });

    // ── Aggregate correctness ─────────────────────────────────────────────────

    it("1 unreversed line → partiallyReversed=false, reversible=true", async () => {
      const { rows } = await listTransactionDocuments(
        financialAccountId,
        null,
        {
          type: "PAY",
          status: null,
          rev: null,
          q: "",
          sort: "-event_at",
          page: 1,
        },
        50,
      );
      const row = rows.find((r) => r.documentId === payCapture1Id);
      expect(row).toBeDefined();
      expect(row!.totalLineCount).toBe(1);
      expect(row!.unreversedLineCount).toBe(1);
      expect(row!.partiallyReversed).toBe(false);
      expect(row!.reversible).toBe(true);
    });

    it("2 lines, 1 reversed → partiallyReversed=true, reversible=true", async () => {
      const { rows } = await listTransactionDocuments(
        financialAccountId,
        ban1Id,
        {
          type: "CRN",
          status: null,
          rev: null,
          q: crn1Id,
          sort: "-event_at",
          page: 1,
        },
        50,
      );
      const row = rows.find((r) => r.documentId === crn1Id);
      expect(row).toBeDefined();
      expect(row!.totalLineCount).toBe(2);
      expect(row!.unreversedLineCount).toBe(1);
      expect(row!.partiallyReversed).toBe(true);
      expect(row!.reversible).toBe(true);
    });

    it("2 lines, both reversed → partiallyReversed=false, reversible=false", async () => {
      const { rows } = await listTransactionDocuments(
        financialAccountId,
        ban1Id,
        {
          type: "CRN",
          status: null,
          rev: null,
          q: crn2Id,
          sort: "-event_at",
          page: 1,
        },
        50,
      );
      const row = rows.find((r) => r.documentId === crn2Id);
      expect(row).toBeDefined();
      expect(row!.totalLineCount).toBe(2);
      expect(row!.unreversedLineCount).toBe(0);
      expect(row!.partiallyReversed).toBe(false);
      expect(row!.reversible).toBe(false);
    });

    it("draft state → reversible=false (state check in service)", async () => {
      const { rows } = await listTransactionDocuments(
        financialAccountId,
        ban1Id,
        {
          type: "DBN",
          status: null,
          rev: null,
          q: "",
          sort: "-event_at",
          page: 1,
        },
        50,
      );
      const row = rows.find((r) => r.documentId === dbn1Id);
      expect(row).toBeDefined();
      expect(row!.reversible).toBe(false);
      expect(row!.partiallyReversed).toBe(false);
    });

    it("actionLabel is '<TypeBase> — <reasonCode>' (ac20-spec §2.4)", async () => {
      const { rows } = await listTransactionDocuments(
        financialAccountId,
        null,
        {
          type: "PAY",
          status: null,
          rev: null,
          q: "",
          sort: "-event_at",
          page: 1,
        },
        50,
      );
      const row = rows.find((r) => r.documentId === payCapture1Id);
      expect(row).toBeDefined();
      expect(row!.actionLabel).toBe("Payment — CUST_PAYMENT");
    });

    // ── Filter composition ────────────────────────────────────────────────────

    it("type=CRN returns only CRN docs in FA+BAN1 scope", async () => {
      const { rows } = await listTransactionDocuments(
        financialAccountId,
        ban1Id,
        {
          type: "CRN",
          status: null,
          rev: null,
          q: "",
          sort: "-event_at",
          page: 1,
        },
        50,
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.docType === "CRN")).toBe(true);
    });

    it("status=draft returns only draft docs", async () => {
      const { rows } = await listTransactionDocuments(
        financialAccountId,
        ban1Id,
        {
          type: null,
          status: "draft",
          rev: null,
          q: "",
          sort: "-event_at",
          page: 1,
        },
        50,
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.state === "draft")).toBe(true);
    });

    it("rev=reversible includes PAY capture, excludes fully-reversed CRN2 and draft DBN", async () => {
      const { rows } = await listTransactionDocuments(
        financialAccountId,
        ban1Id,
        {
          type: null,
          status: null,
          rev: "reversible",
          q: "",
          sort: "-event_at",
          page: 1,
        },
        50,
      );
      const ids = rows.map((r) => r.documentId);
      expect(ids).toContain(payCapture1Id);
      expect(ids).toContain(depCapture1Id);
      expect(ids).not.toContain(crn2Id);
      expect(ids).not.toContain(dbn1Id);
    });

    it("rev=partial returns only partially-reversed docs", async () => {
      const { rows } = await listTransactionDocuments(
        financialAccountId,
        ban1Id,
        {
          type: null,
          status: null,
          rev: "partial",
          q: "",
          sort: "-event_at",
          page: 1,
        },
        50,
      );
      expect(rows.every((r) => r.partiallyReversed)).toBe(true);
      const ids = rows.map((r) => r.documentId);
      expect(ids).toContain(crn1Id);
    });

    it("q filter by documentId prefix matches and excludes non-matching docs", async () => {
      const prefix = payCapture1Id.slice(0, 5);
      const { rows } = await listTransactionDocuments(
        financialAccountId,
        null,
        {
          type: null,
          status: null,
          rev: null,
          q: prefix,
          sort: "-event_at",
          page: 1,
        },
        50,
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.documentId.includes(prefix))).toBe(true);
    });

    // ── Sort ──────────────────────────────────────────────────────────────────

    it("sort=event_at returns oldest doc first across the FA", async () => {
      const { rows } = await listTransactionDocuments(
        financialAccountId,
        null,
        {
          type: null,
          status: null,
          rev: null,
          q: "",
          sort: "event_at",
          page: 1,
        },
        50,
      );
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i]!.eventAt.getTime()).toBeGreaterThanOrEqual(
          rows[i - 1]!.eventAt.getTime(),
        );
      }
    });

    it("sort=-event_at returns newest doc first", async () => {
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
        50,
      );
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i]!.eventAt.getTime()).toBeLessThanOrEqual(
          rows[i - 1]!.eventAt.getTime(),
        );
      }
    });

    it("sort=amount returns smallest-amount doc first (numeric order, not lexicographic)", async () => {
      const { rows } = await listTransactionDocuments(
        financialAccountId,
        null,
        { type: null, status: null, rev: null, q: "", sort: "amount", page: 1 },
        50,
      );
      for (let i = 1; i < rows.length; i++) {
        expect(Number(rows[i]!.totalAmount)).toBeGreaterThanOrEqual(
          Number(rows[i - 1]!.totalAmount),
        );
      }
    });

    // ── Pagination ────────────────────────────────────────────────────────────

    it("pagination: total reflects full count even when page size < total", async () => {
      // FA-wide, no filters — 6 docs created in setup.
      const { total, rows } = await listTransactionDocuments(
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
        2,
      );
      expect(total).toBe(6);
      // Page 1 with size=2 returns at most 2 rows.
      expect(rows.length).toBeLessThanOrEqual(2);
    });

    it("pagination: page 2 with size 2 returns the next 2 docs", async () => {
      const page1 = await listTransactionDocuments(
        financialAccountId,
        null,
        {
          type: null,
          status: null,
          rev: null,
          q: "",
          sort: "event_at",
          page: 1,
        },
        2,
      );
      const page2 = await listTransactionDocuments(
        financialAccountId,
        null,
        {
          type: null,
          status: null,
          rev: null,
          q: "",
          sort: "event_at",
          page: 2,
        },
        2,
      );
      const page1Ids = new Set(page1.rows.map((r) => r.documentId));
      const page2Ids = page2.rows.map((r) => r.documentId);
      // No overlap between pages.
      for (const id of page2Ids) {
        expect(page1Ids.has(id)).toBe(false);
      }
    });

    // ── inv. #19 — exactly five document types ────────────────────────────────

    it("inv. #19: DOC_TYPES has exactly 5 members (PAY/DEP/CRN/DBN/ADJ)", () => {
      expect(DOC_TYPES).toHaveLength(5);
      expect(DOC_TYPES).toContain("PAY");
      expect(DOC_TYPES).toContain("DEP");
      expect(DOC_TYPES).toContain("CRN");
      expect(DOC_TYPES).toContain("DBN");
      expect(DOC_TYPES).toContain("ADJ");
    });
  },
);
