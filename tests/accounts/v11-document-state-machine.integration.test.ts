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
import { capturePayment } from "@/services/accounts/capture-payment";
import { approveDocument } from "@/services/accounts/document-state-machine";
import { postDocument } from "@/services/accounts/post-document";

// ac07-spec §3.10 v11-document-state-machine.integration.test.ts — V11:
// threshold routing, APPROVAL_REQUIRED, SELF_APPROVAL, atomic multi-leg
// post, UNBALANCED_DOC, PERIOD_CLOSED (with re-date hint), every posted
// line ↔ exactly one transfer (Module Inv. #3).
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "V11 — document state machine (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let creatorId: string;
    let managerId: string;
    let financialAccountId: string;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);

      // Schema drop + migrate on a short-lived connection, then a fresh one
      // for everything else — see ledger-explorer.integration.test.ts's
      // beforeAll comment: migrate() poisons its own connection's type-OID
      // cache, causing later timestamptz reads to come back as raw strings
      // instead of parsed Dates on that same connection.
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
        VALUES ('test-user-v11-creator', 'V11 Creator', 'v11-creator@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id
      `;
      creatorId = creator!.id;

      const [manager] = await sql<{ id: string }[]>`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES ('test-user-v11-manager', 'V11 Manager', 'v11-manager@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id
      `;
      managerId = manager!.id;

      await sql`SELECT id FROM billing.pgledger_create_account('sys.cash.MYR', 'MYR')`;

      await sql`
        INSERT INTO billing.reason_code (reason_code, doc_type, posting_nature, auto_post_limit, state)
        VALUES
          ('CUST_PAYMENT', 'PAY', 'cash', 100000.00, 'active'),
          ('ADVANCE_PAYMENT', 'PAY', 'cash', 100000.00, 'active'),
          ('PAYMENT_REFUND', 'PAY', 'cash', 0.00, 'active')
      `;

      const [cycle] = await sql<{ id: string }[]>`
        INSERT INTO billing.bill_cycle (name, frequency, cycle_day, payment_due_days, state)
        VALUES ('V11 Monthly', 'monthly', 1, 30, 'active')
        RETURNING bill_cycle_id AS id
      `;

      const [org] = await sql<{ id: string }[]>`
        INSERT INTO customer.organization (name, organization_type, last_modified_by)
        VALUES ('V11 Test Corp', 'COMPANY', ${creatorId})
        RETURNING organization_id AS id
      `;
      const [pr] = await sql<{ id: string; ts: Date }[]>`
        INSERT INTO customer.party_role (engaged_party, status, last_modified_by)
        VALUES (${org!.id}, 'INITIALIZED', ${creatorId})
        RETURNING party_role_id AS id, last_modified_datetime AS ts
      `;

      const result = await onboardCustomerAccounts(
        {
          partyRoleId: pr!.id,
          billCycleId: cycle!.id,
          currency: "MYR",
          statusReason: "V11 state-machine test",
          lastModifiedDatetime: pr!.ts,
        },
        creatorId,
      );
      if (!result.ok) throw new Error(`onboarding failed: ${result.code}`);
      financialAccountId = result.value.financialAccountId;
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

    it("USER posts directly at/below the reason code's auto_post_limit", async () => {
      const result = await capturePayment(
        {
          financialAccountId,
          reasonCode: "CUST_PAYMENT",
          amount: "5400.00",
          payment_mode: "bank_transfer",
          mode_ref: { bankRef: "V11-BELOW-LIMIT" },
          eventAt: new Date("2026-02-10T00:00:00.000Z"),
          entryDate: new Date("2026-02-10T00:00:00.000Z"),
          referenceInfo: "V11 below-limit capture",
        },
        creatorId,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.state).toBe("posted");

      const lines = await documentLineRepository.findByDocumentId(
        db,
        result.value.documentId,
      );
      expect(lines).toHaveLength(1);
      expect(lines[0]!.pgledgerTransferId).not.toBeNull();
    });

    it("above the limit routes to pending_approval, and a further USER post attempt is rejected with APPROVAL_REQUIRED", async () => {
      const result = await capturePayment(
        {
          financialAccountId,
          reasonCode: "CUST_PAYMENT",
          amount: "150000.00",
          payment_mode: "bank_transfer",
          mode_ref: { bankRef: "V11-ABOVE-LIMIT" },
          eventAt: new Date("2026-02-11T00:00:00.000Z"),
          entryDate: new Date("2026-02-11T00:00:00.000Z"),
          referenceInfo: "V11 above-limit capture",
        },
        creatorId,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.state).toBe("pending_approval");

      // A further attempt to post it directly (simulating a USER trying to
      // force a post on a still-unapproved document) is rejected.
      const rejected = await db.transaction((tx) =>
        postDocument(tx, result.value.documentId, creatorId),
      );
      expect(rejected).toEqual({ ok: false, code: "APPROVAL_REQUIRED" });
    });

    it("approved_by == created_by is rejected with SELF_APPROVAL", async () => {
      const captured = await capturePayment(
        {
          financialAccountId,
          reasonCode: "CUST_PAYMENT",
          amount: "150001.00",
          payment_mode: "bank_transfer",
          mode_ref: { bankRef: "V11-SELF-APPROVAL" },
          eventAt: new Date("2026-02-12T00:00:00.000Z"),
          entryDate: new Date("2026-02-12T00:00:00.000Z"),
          referenceInfo: "V11 self-approval capture",
        },
        creatorId,
      );
      expect(captured.ok).toBe(true);
      if (!captured.ok) return;
      expect(captured.value.state).toBe("pending_approval");

      const selfApprove = await db.transaction((tx) =>
        approveDocument(tx, captured.value.documentId, creatorId),
      );
      expect(selfApprove).toEqual({ ok: false, code: "SELF_APPROVAL" });
    });

    it("a non-creator MANAGER approval posts all lines atomically", async () => {
      const captured = await capturePayment(
        {
          financialAccountId,
          reasonCode: "CUST_PAYMENT",
          amount: "150002.00",
          payment_mode: "bank_transfer",
          mode_ref: { bankRef: "V11-MANAGER-APPROVE" },
          eventAt: new Date("2026-02-13T00:00:00.000Z"),
          entryDate: new Date("2026-02-13T00:00:00.000Z"),
          referenceInfo: "V11 manager-approve capture",
        },
        creatorId,
      );
      expect(captured.ok).toBe(true);
      if (!captured.ok) return;

      const approved = await db.transaction((tx) =>
        approveDocument(tx, captured.value.documentId, managerId),
      );
      expect(approved.ok).toBe(true);
      if (!approved.ok) return;
      expect(approved.value.state).toBe("posted");

      const lines = await documentLineRepository.findByDocumentId(
        db,
        captured.value.documentId,
      );
      expect(lines).toHaveLength(1);
      expect(lines[0]!.pgledgerTransferId).not.toBeNull();
    });

    it("total_amount ≠ Σ lines is rejected with UNBALANCED_DOC", async () => {
      const doc = await db.transaction((tx) =>
        documentRepository.insert(tx, "PAY", {
          state: "draft",
          refFinancialAccountId: financialAccountId,
          refBillingAccountId: null,
          reasonCode: "CUST_PAYMENT",
          currency: "MYR",
          totalAmount: "100.00",
          paymentMode: "cash",
          modeRef: { receiptNo: "V11-UNBALANCED" },
          entryDate: new Date("2026-02-14T00:00:00.000Z"),
          referenceInfo: "V11 unbalanced doc",
          eventAt: new Date("2026-02-14T00:00:00.000Z"),
          postedAt: null,
          reversalOf: null,
          createdBy: creatorId,
          approvedBy: null,
          metadata: null,
          lastEditedBy: creatorId,
        }),
      );
      await db.transaction((tx) =>
        documentLineRepository.insert(tx, {
          refDocumentId: doc.documentId,
          lineNo: 1,
          lineKind: "capture",
          refBillingAccountId: null,
          refSettledDocumentId: null,
          amount: "99.00",
          pgledgerTransferId: null,
          reversedByLineId: null,
          lastEditedBy: creatorId,
        }),
      );

      const result = await db.transaction((tx) =>
        postDocument(tx, doc.documentId, creatorId),
      );
      expect(result).toEqual({ ok: false, code: "UNBALANCED_DOC" });
    });

    it("posting into a closed period is rejected with PERIOD_CLOSED and a re-date hint, preserving event_at", async () => {
      await sql`
        INSERT INTO billing.accounting_period (period, currency, state)
        VALUES ('2025-01', 'MYR', 'closed')
      `;

      const result = await capturePayment(
        {
          financialAccountId,
          reasonCode: "CUST_PAYMENT",
          amount: "10.00",
          payment_mode: "cash",
          mode_ref: { receiptNo: "V11-CLOSED-PERIOD" },
          eventAt: new Date("2025-01-15T00:00:00.000Z"),
          entryDate: new Date("2025-01-15T00:00:00.000Z"),
          referenceInfo: "V11 closed-period capture",
        },
        creatorId,
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("PERIOD_CLOSED");
      if (result.code !== "PERIOD_CLOSED") return;
      expect(result.openPeriodHint).toContain("2025-01");

      const doc = await documentRepository.findById(
        db,
        // The document was created in draft, then rejected at post — find it
        // via its distinguishing mode_ref rather than an id we don't have.
        (
          await sql<{ document_id: string }[]>`
          SELECT document_id FROM billing.document
          WHERE mode_ref->>'receiptNo' = 'V11-CLOSED-PERIOD'
          LIMIT 1
        `
        )[0]!.document_id,
      );
      expect(doc).not.toBeNull();
      expect(doc!.state).toBe("draft");
      expect(doc!.eventAt.toISOString().slice(0, 10)).toBe("2025-01-15");
    });

    it("every posted line has exactly one transfer, and no transfer exists without a posted line (Inv. #3)", async () => {
      const orphanRows = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM billing.pgledger_transfers_view t
        WHERE NOT EXISTS (
          SELECT 1 FROM billing.document_line dl
          WHERE dl.pgledger_transfer_id = t.id
        )
      `;
      expect(Number(orphanRows[0]!.count)).toBe(0);

      const unstampedRows = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM billing.document_line dl
        JOIN billing.document d ON d.document_id = dl.ref_document_id
        WHERE d.state = 'posted' AND dl.pgledger_transfer_id IS NULL
      `;
      expect(Number(unstampedRows[0]!.count)).toBe(0);
    });

    it("V1 — zero-sum holds after every posting in this suite", async () => {
      const [sum] = await sql<{ total: string | null }[]>`
        SELECT sum(balance)::text AS total FROM billing.pgledger_accounts_view
      `;
      expect(Number(sum?.total ?? "0")).toBe(0);
    });
  },
);
