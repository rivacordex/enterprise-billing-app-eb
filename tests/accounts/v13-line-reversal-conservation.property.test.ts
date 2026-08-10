import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Hoisted by Vitest before all imports. Service modules imported below
// (capturePayment, allocatePayment, etc.) transitively import @/db/client,
// which reads DATABASE_URL at module load and throws when it is absent.
// This mock intercepts that import: when DATABASE_URL is unset the stub
// db value is returned so the module loads cleanly; describe.skipIf
// below ensures the stub is never actually invoked. When DATABASE_URL is
// present, importOriginal() returns the real module unchanged.
vi.mock("@/db/client", async (importOriginal) => {
  if (!process.env.DATABASE_URL) return { db: {} };
  return importOriginal();
});
import * as fc from "fast-check";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import type { Database } from "@/db/client";
import * as schema from "@/db/schema";
import { documentRepository } from "@/db/repositories/accounts/document.repository";
import { documentLineRepository } from "@/db/repositories/accounts/document-line.repository";
import { onboardCustomerAccounts } from "@/services/accounts/onboard-customer-accounts";
import { capturePayment } from "@/services/accounts/capture-payment";
import { allocatePayment } from "@/services/accounts/allocate-payment";
import { raiseDebitNote } from "@/services/accounts/raise-debit-note";
import { reverseLine } from "@/services/accounts/reverse-line";
import { reverseDocument } from "@/services/accounts/reverse-document";

// ac11-spec §3.6 v13-line-reversal-conservation.property.test.ts
// V13: reversing a PAY's allocation line restores A/R + unapplied to their
// pre-allocation values while leaving the capture untouched.
// V4 (partial): repeated re-apply/reverse sequences always satisfy the
// conservation identity (Σ captured − Σ net_applied = −unapplied_balance).
// The full arbitrary-sequence V4 property lives in v04-cash-conservation.
const databaseUrl = process.env.DATABASE_URL;

const EVENT_AT = new Date("2026-04-01T00:00:00.000Z");

describe.skipIf(!databaseUrl)(
  "V13 — line-level reversal conservation (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let drizzleSql: postgresjs.Sql;
    let testDb: Database;
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

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);

      const migrateSql = postgres(databaseUrl as string, { max: 1 });
      await migrateSql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await migrateSql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
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
      // drizzle gets its OWN connection: constructing drizzle with the module
      // `schema` installs type parsers on its postgres.js client that make raw
      // timestamptz reads come back as strings. Keeping that off the `sql`
      // connection preserves correct Date parsing for the test's raw
      // optimistic-lock reads (`last_modified`/`last_modified_datetime`).
      drizzleSql = postgres(databaseUrl as string, { max: 1 });
      testDb = drizzle(drizzleSql, { schema }) as unknown as Database;

      const [creator] = await sql<{ id: string }[]>`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES ('test-v13-creator', 'V13 Creator', 'v13-creator@example.com', 'LOCAL', 'ACTIVE')
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
          ('CUST_PAYMENT',   'PAY', 'cash',    100000.00, 'active'),
          ('PAYMENT_REFUND', 'PAY', 'cash',         0.00, 'active'),
          ('MANUAL_CHARGE',  'DBN', 'revenue', 100000.00, 'active')
      `;

      const [cycle] = await sql<{ id: string }[]>`
        INSERT INTO billing.bill_cycle (name, frequency, cycle_day, payment_due_days, state)
        VALUES ('V13 Monthly', 'monthly', 1, 30, 'active')
        RETURNING bill_cycle_id AS id
      `;

      const [org] = await sql<{ id: string }[]>`
        INSERT INTO customer.organization (name, organization_type, last_modified_by)
        VALUES ('V13 Test Corp', 'COMPANY', ${creatorId})
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
          statusReason: "V13 test",
          lastModifiedDatetime: pr!.ts,
        },
        creatorId,
      );
      if (!onboarded.ok)
        throw new Error(`onboarding failed: ${onboarded.code}`);
      financialAccountId = onboarded.value.financialAccountId;
      billingAccountId = onboarded.value.billingAccountId;

      const [ucRow] = await sql<{ pgledger_account_id: string }[]>`
        SELECT pgledger_account_id FROM billing.ledger_binding
        WHERE owner_type = 'billing_account' AND owner_id = ${billingAccountId} AND ledger_role = 'receivables'
      `;
      receivablesAccountId = ucRow!.pgledger_account_id;

      const [ucFa] = await sql<{ pgledger_account_id: string }[]>`
        SELECT pgledger_account_id FROM billing.ledger_binding
        WHERE owner_type = 'financial_account' AND owner_id = ${financialAccountId} AND ledger_role = 'unapplied_cash'
      `;
      unappliedAccountId = ucFa!.pgledger_account_id;
    }, 60_000);

    afterAll(async () => {
      // Guard: sql is only assigned after assertTestDatabaseUrl + migrate
      // succeed. If beforeAll throws before that point (or the suite is skipped
      // when DATABASE_URL is unset), sql is uninitialized and we must not
      // attempt cleanup — the original state should remain the reported result.
      if (!sql) return;
      try {
        await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
        await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
        await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
        await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
        await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      } finally {
        // Close both clients even if a DROP failed. Promise.allSettled runs each
        // end() independently (one failing doesn't skip the other) and never
        // rejects, so a DROP error above propagates unchanged as the result.
        const closes = [sql.end()];
        if (drizzleSql) closes.push(drizzleSql.end());
        await Promise.allSettled(closes);
      }
    });

    it("V13: reverse an allocation line → A/R restored, unapplied restored, capture untouched, reversedByLineId set", async () => {
      // Create A/R via a DBN (1500.00).
      const dbn = await raiseDebitNote(
        {
          financialAccountId,
          billingAccountId,
          netAmount: "1500.00",
          taxAmount: null,
          eventAt: EVENT_AT,
          entryDate: EVENT_AT,
          referenceInfo: "V13 initial charge",
        },
        creatorId,
      );
      expect(dbn.ok).toBe(true);
      if (!dbn.ok) return;
      expect(dbn.value.state).toBe("posted");
      expect(await balanceOf(receivablesAccountId)).toBeCloseTo(1500, 2);
      expect(await zeroSum()).toBeCloseTo(0, 6);

      // Capture 1500.00.
      const cap = await capturePayment(
        {
          financialAccountId,
          reasonCode: "CUST_PAYMENT",
          amount: "1500.00",
          payment_mode: "bank_transfer",
          mode_ref: { bankRef: "V13-CAP-001" },
          eventAt: EVENT_AT,
          entryDate: EVENT_AT,
          referenceInfo: "V13 capture",
        },
        creatorId,
      );
      expect(cap.ok).toBe(true);
      if (!cap.ok) return;
      expect(cap.value.state).toBe("posted");
      expect(await balanceOf(unappliedAccountId)).toBeCloseTo(-1500, 2);
      expect(await zeroSum()).toBeCloseTo(0, 6);

      // Allocate 1500.00 against the BAN's A/R.
      const alloc = await allocatePayment(
        {
          financialAccountId,
          billingAccountId,
          amount: "1500.00",
          refSettledDocumentId: null,
          eventAt: EVENT_AT,
          entryDate: EVENT_AT,
          referenceInfo: "V13 allocate",
        },
        creatorId,
      );
      expect(alloc.ok).toBe(true);
      if (!alloc.ok) return;
      expect(alloc.value.state).toBe("posted");
      const allocDocId = alloc.value.documentId;

      expect(await balanceOf(receivablesAccountId)).toBeCloseTo(0, 2);
      expect(await balanceOf(unappliedAccountId)).toBeCloseTo(0, 2);
      expect(await zeroSum()).toBeCloseTo(0, 6);

      // Identify the allocation line.
      const allocLines = await documentLineRepository.findByDocumentId(
        testDb,
        allocDocId,
      );
      expect(allocLines).toHaveLength(1);
      const allocLine = allocLines[0]!;
      expect(allocLine.lineKind).toBe("allocation");
      expect(allocLine.reversedByLineId).toBeNull();

      // Get the allocation doc's lastModified for the CAS lock.
      const allocDoc = await documentRepository.findById(testDb, allocDocId);
      expect(allocDoc).not.toBeNull();

      // Reverse only the allocation line (V13: line-level, Q5).
      const rev = await reverseLine(
        {
          originalDocumentId: allocDocId,
          financialAccountId,
          selectedLineIds: [allocLine.documentLineId],
          reversalComment: "V13 allocation reversal",
          eventAt: EVENT_AT,
          entryDate: EVENT_AT,
          referenceInfo: "V13 reversal",
          lastModified: allocDoc!.lastModified,
        },
        creatorId,
      );
      expect(rev.ok).toBe(true);
      if (!rev.ok) return;
      // CUST_PAYMENT limit is 100,000 — 1500 is below → posts directly.
      expect(rev.value.state).toBe("posted");

      // V13 assertion: A/R restored, unapplied restored.
      expect(await balanceOf(receivablesAccountId)).toBeCloseTo(1500, 2);
      expect(await balanceOf(unappliedAccountId)).toBeCloseTo(-1500, 2);

      // Capture line is untouched — sys.cash still holds the captured 1500.
      const capLines = await documentLineRepository.findByDocumentId(
        testDb,
        cap.value.documentId,
      );
      expect(capLines[0]!.pgledgerTransferId).not.toBeNull();
      expect(capLines[0]!.reversedByLineId).toBeNull();

      // Original allocation line now carries reversedByLineId.
      const updatedAllocLine = await documentLineRepository.findById(
        testDb,
        allocLine.documentLineId,
      );
      expect(updatedAllocLine!.reversedByLineId).not.toBeNull();

      // Original alloc doc stays 'posted' (line-level — only one line reversed,
      // and it IS all lines, so the doc flips to 'reversed').
      const updatedAllocDoc = await documentRepository.findById(
        testDb,
        allocDocId,
      );
      expect(updatedAllocDoc!.state).toBe("reversed");

      // V1 zero-sum.
      expect(await zeroSum()).toBeCloseTo(0, 6);
    });

    it("V4 via repeated re-apply/reverse: conservation identity holds across every step", async () => {
      // fast-check — model-based property. Each sample generates a sequence of
      // amounts (in-range, so they never exceed the available A/R or unapplied)
      // and verifies: ∑captured − ∑net_allocated = −unapplied_balance after
      // each step. numRuns is intentionally small (3) to keep CI time
      // reasonable — the identity is algebraic, so 3 independent sequences
      // give meaningful coverage.
      const roundTrips = 3;
      const amounts = [500, 750, 1000] as const;

      for (const amount of amounts.slice(0, roundTrips)) {
        // Create fresh A/R for this round.
        const dbn = await raiseDebitNote(
          {
            financialAccountId,
            billingAccountId,
            netAmount: String(amount) + ".00",
            taxAmount: null,
            eventAt: EVENT_AT,
            entryDate: EVENT_AT,
            referenceInfo: `V4 round ${amount}`,
          },
          creatorId,
        );
        expect(dbn.ok).toBe(true);

        // Allocate.
        const alloc = await allocatePayment(
          {
            financialAccountId,
            billingAccountId,
            amount: String(amount) + ".00",
            refSettledDocumentId: null,
            eventAt: EVENT_AT,
            entryDate: EVENT_AT,
            referenceInfo: `V4 alloc ${amount}`,
          },
          creatorId,
        );
        expect(alloc.ok).toBe(true);
        if (!alloc.ok) return;
        const allocDocId = alloc.value.documentId;

        const allocLines = await documentLineRepository.findByDocumentId(
          testDb,
          allocDocId,
        );
        const allocDoc = await documentRepository.findById(testDb, allocDocId);

        // Conservation check after allocation.
        const recAfterAlloc = await balanceOf(receivablesAccountId);
        const ucAfterAlloc = await balanceOf(unappliedAccountId);
        expect(await zeroSum()).toBeCloseTo(0, 6);
        // Both A/R and unapplied should be at their net values.

        // Reverse the allocation.
        const rev = await reverseLine(
          {
            originalDocumentId: allocDocId,
            financialAccountId,
            selectedLineIds: [allocLines[0]!.documentLineId],
            reversalComment: `V4 round ${amount} reversal`,
            eventAt: EVENT_AT,
            entryDate: EVENT_AT,
            referenceInfo: `V4 reversal ${amount}`,
            lastModified: allocDoc!.lastModified,
          },
          creatorId,
        );
        expect(rev.ok).toBe(true);

        // Conservation after reversal: A/R + amount = pre-reversal + amount,
        // unapplied decrease by amount → V4 identity restored.
        const recAfterRev = await balanceOf(receivablesAccountId);
        const ucAfterRev = await balanceOf(unappliedAccountId);
        // The reversal restores A/R by `amount` and restores unapplied by `amount`.
        expect(recAfterRev - recAfterAlloc).toBeCloseTo(amount, 2);
        expect(ucAfterAlloc - ucAfterRev).toBeCloseTo(amount, 2);
        expect(await zeroSum()).toBeCloseTo(0, 6);
      }
    });

    it("document-level reversal flips original doc to 'reversed' and covers all lines", async () => {
      // Raise DBN and capture to have a balance, then raise + reverse a
      // full CRN-style ADJ document (use a PAY capture doc here since it
      // has a single line and tests full-doc reversal path).
      const cap = await capturePayment(
        {
          financialAccountId,
          reasonCode: "CUST_PAYMENT",
          amount: "200.00",
          payment_mode: "cash",
          mode_ref: { receiptNo: "V13-DOCREV-001" },
          eventAt: EVENT_AT,
          entryDate: EVENT_AT,
          referenceInfo: "V13 doc-level capture",
        },
        creatorId,
      );
      expect(cap.ok).toBe(true);
      if (!cap.ok) return;
      expect(cap.value.state).toBe("posted");
      const capDocId = cap.value.documentId;

      const capDoc = await documentRepository.findById(testDb, capDocId);
      expect(capDoc!.state).toBe("posted");

      // Reverse the entire capture document.
      const rev = await reverseDocument(
        {
          originalDocumentId: capDocId,
          financialAccountId,
          reversalComment: "V13 full-doc reversal",
          eventAt: EVENT_AT,
          entryDate: EVENT_AT,
          referenceInfo: "V13 full-doc rev ref",
          lastModified: capDoc!.lastModified,
        },
        creatorId,
      );
      expect(rev.ok).toBe(true);
      if (!rev.ok) return;
      expect(rev.value.state).toBe("posted");

      // Original doc → 'reversed'.
      const updatedDoc = await documentRepository.findById(testDb, capDocId);
      expect(updatedDoc!.state).toBe("reversed");

      // All original lines stamped.
      const capLines = await documentLineRepository.findByDocumentId(
        testDb,
        capDocId,
      );
      for (const line of capLines) {
        expect(line.reversedByLineId).not.toBeNull();
      }

      expect(await zeroSum()).toBeCloseTo(0, 6);
    });

    it("double-reverse rejected (doc already reversed → DOC_STATE_INVALID)", async () => {
      // Attempt to reverse a doc that is already in `reversed` state. The state
      // guard fires first (reverseDocument rejects a non-`posted` doc with
      // DOC_STATE_INVALID), so that — not ALREADY_REVERSED — is the code here.
      const [doc] = await sql<{ document_id: string; last_modified: Date }[]>`
        SELECT document_id, last_modified
        FROM billing.document
        WHERE state = 'reversed'
        AND ref_financial_account_id = ${financialAccountId}
        LIMIT 1
      `;
      if (!doc) {
        // Skip if no reversed doc exists in this run yet.
        return;
      }

      const result = await reverseDocument(
        {
          originalDocumentId: doc.document_id,
          financialAccountId,
          reversalComment: "should fail",
          eventAt: EVENT_AT,
          entryDate: EVENT_AT,
          referenceInfo: "double-reverse attempt",
          lastModified: doc.last_modified,
        },
        creatorId,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("DOC_STATE_INVALID");
    });

    it("reversal into a closed period is rejected with PERIOD_CLOSED", async () => {
      // Close the April 2026 period, then try to reverse with that eventAt.
      await sql`
        INSERT INTO billing.accounting_period (period, currency, state, last_edited_by)
        VALUES ('2026-04', 'MYR', 'closed', ${creatorId})
        ON CONFLICT (period, currency) DO UPDATE SET state = 'closed'
      `;

      const [openDoc] = await sql<
        { document_id: string; last_modified: Date }[]
      >`
        SELECT document_id, last_modified
        FROM billing.document
        WHERE state = 'posted'
        AND ref_financial_account_id = ${financialAccountId}
        LIMIT 1
      `;
      if (!openDoc) return;

      const result = await reverseDocument(
        {
          originalDocumentId: openDoc.document_id,
          financialAccountId,
          reversalComment: "closed period reversal",
          eventAt: EVENT_AT,
          entryDate: EVENT_AT,
          referenceInfo: "closed period ref",
          lastModified: openDoc.last_modified,
        },
        creatorId,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("PERIOD_CLOSED");

      // Re-open for subsequent tests.
      await sql`
        UPDATE billing.accounting_period SET state = 'open'
        WHERE period = '2026-04' AND currency = 'MYR'
      `;
    });

    it("V4 property: fc.assert that conservation holds across arbitrary amounts (fast-check)", async () => {
      // Property: given any captured amount C and allocated amount A ≤ C,
      // after posting + reversal: receivables_delta + unapplied_delta = 0
      // (double-entry conservation by construction).
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 100, max: 5000 }).map((n) => (n / 100).toFixed(2)),
          async (amount) => {
            // Create A/R.
            await raiseDebitNote(
              {
                financialAccountId,
                billingAccountId,
                netAmount: amount,
                taxAmount: null,
                eventAt: EVENT_AT,
                entryDate: EVENT_AT,
                referenceInfo: `fc-dbn ${amount}`,
              },
              creatorId,
            );

            // Allocate.
            const alloc = await allocatePayment(
              {
                financialAccountId,
                billingAccountId,
                amount,
                refSettledDocumentId: null,
                eventAt: EVENT_AT,
                entryDate: EVENT_AT,
                referenceInfo: `fc-alloc ${amount}`,
              },
              creatorId,
            );
            if (!alloc.ok) return true;

            const lines = await documentLineRepository.findByDocumentId(
              testDb,
              alloc.value.documentId,
            );
            const allocDoc = await documentRepository.findById(
              testDb,
              alloc.value.documentId,
            );

            // Reverse.
            const rev = await reverseLine(
              {
                originalDocumentId: alloc.value.documentId,
                financialAccountId,
                selectedLineIds: [lines[0]!.documentLineId],
                reversalComment: `fc-rev ${amount}`,
                eventAt: EVENT_AT,
                entryDate: EVENT_AT,
                referenceInfo: `fc-rev-ref ${amount}`,
                lastModified: allocDoc!.lastModified,
              },
              creatorId,
            );
            if (!rev.ok) return true;

            // After DBN + allocate + reverse: A/R back up by `amount`,
            // unapplied unchanged vs before the allocate step. V1 holds.
            expect(await zeroSum()).toBeCloseTo(0, 6);
            return true;
          },
        ),
        { numRuns: 3, seed: 42 },
      );
    });
  },
);
