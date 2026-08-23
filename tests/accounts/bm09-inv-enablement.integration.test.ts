import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { db } from "@/db/client";
import { onboardCustomerAccounts } from "@/services/accounts/onboard-customer-accounts";
import { raiseDebitNote } from "@/services/accounts/raise-debit-note";
import { documentRepository } from "@/db/repositories/accounts/document.repository";
import { documentLineRepository } from "@/db/repositories/accounts/document-line.repository";
import { submitDocument } from "@/services/accounts/document-state-machine";
import { closePeriod, getPeriodState } from "@/services/accounts/period-close";

// bm09-spec §5 — the Accounts-side INV & posting enablement. An INV
// document under the seeded STANDARD_INVOICE reason code auto-posts directly
// from draft (never pending_approval) through the ordinary generic
// postDocument/leg-templates machinery — no INV-specific posting code
// exists. Existing doc types (DBN here) still post unaffected by the widened
// doc_type CHECKs (additive only). The period-close guard blocks closing a
// (period, currency) while a bill_run's gl_event_at falls in it and the run
// isn't COMPLETED/CANCELLED, and allows it once the run completes.
//
// Deliberately NOT named `vNN-*` — that pattern is the closed, audited
// V1-V14 Accounts module-invariant sequence (tests/accounts/verification-
// audit.test.ts's "no orphan V-test" gate), and this cross-module billing
// unit isn't one of the 14 architecture.md §6 invariants it maps.
const databaseUrl = process.env.DATABASE_URL;
const EVENT_AT = new Date("2026-04-10T00:00:00.000Z");
const GUARD_PERIOD = "2026-05";

describe.skipIf(!databaseUrl)(
  "bm09 — INV enablement + period-close guard (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let actorId: string;
    let financialAccountId: string;
    let billingAccountId: string;
    let receivablesAccountId: string;
    let revenueAccountId: string;
    let taxAccountId: string;
    let billCycleId: string;

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

      const [actor] = await sql<{ id: string }[]>`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES ('test-bm09-actor', 'bm09 Actor', 'bm09-actor@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id
      `;
      actorId = actor!.id;

      revenueAccountId = (
        await sql<{ id: string }[]>`
          SELECT id FROM billing.pgledger_create_account('sys.revenue.MYR', 'MYR')
        `
      )[0]!.id;
      taxAccountId = (
        await sql<{ id: string }[]>`
          SELECT id FROM billing.pgledger_create_account('sys.tax_payable.MYR', 'MYR')
        `
      )[0]!.id;

      // The two reason codes this file exercises: the pre-existing DBN
      // MANUAL_CHARGE (proves existing Accounts behavior is unchanged) and
      // bm09's new INV STANDARD_INVOICE.
      await sql`
        INSERT INTO billing.reason_code (reason_code, doc_type, posting_nature, auto_post_limit, state)
        VALUES
          ('MANUAL_CHARGE', 'DBN', 'revenue', '10000.00', 'active'),
          ('STANDARD_INVOICE', 'INV', 'revenue', '999999999999.99', 'active')
      `;

      const [cycle] = await sql<{ id: string }[]>`
        INSERT INTO billing.bill_cycle (name, frequency, cycle_day, payment_due_days, state)
        VALUES ('bm09 Monthly', 'monthly', 1, 30, 'active')
        RETURNING bill_cycle_id AS id
      `;
      billCycleId = cycle!.id;

      const [org] = await sql<{ id: string }[]>`
        INSERT INTO customer.organization (name, organization_type, last_modified_by)
        VALUES ('bm09 Test Corp', 'COMPANY', ${actorId})
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
          billCycleId,
          currency: "MYR",
          statusReason: "bm09 INV enablement test",
          lastModifiedDatetime: pr!.ts,
        },
        actorId,
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
      if (!sql) return;
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    it("bm09-1 — an INV STANDARD_INVOICE document auto-posts directly from draft (never pending_approval); document_inv_seq yields INV00000001", async () => {
      const result = await db.transaction(async (tx) => {
        const doc = await documentRepository.insert(tx, "INV", {
          state: "draft",
          refFinancialAccountId: financialAccountId,
          refBillingAccountId: billingAccountId,
          reasonCode: "STANDARD_INVOICE",
          currency: "MYR",
          totalAmount: "1080.00",
          paymentMode: null,
          modeRef: null,
          entryDate: EVENT_AT,
          referenceInfo: "bm09 INV auto-post",
          eventAt: EVENT_AT,
          postedAt: null,
          reversalOf: null,
          createdBy: actorId,
          approvedBy: null,
          metadata: null,
          lastEditedBy: actorId,
        });

        // Mirrors the two-line shape raise-debit-note.ts establishes for
        // DBN: a `charge` revenue line + a `release`-keyed tax line (bm09
        // reuses the exact same (docType, lineKind) leg-template
        // disambiguation). bm11 owns constructing these lines for real; this
        // test constructs them directly since bm09 only enables posting.
        await documentLineRepository.insert(tx, {
          refDocumentId: doc.documentId,
          lineNo: 1,
          lineKind: "charge",
          refBillingAccountId: billingAccountId,
          refSettledDocumentId: null,
          amount: "1000.00",
          pgledgerTransferId: null,
          reversedByLineId: null,
          lastEditedBy: actorId,
        });
        await documentLineRepository.insert(tx, {
          refDocumentId: doc.documentId,
          lineNo: 2,
          lineKind: "release",
          refBillingAccountId: billingAccountId,
          refSettledDocumentId: null,
          amount: "80.00",
          pgledgerTransferId: null,
          reversedByLineId: null,
          lastEditedBy: actorId,
        });

        return submitDocument(tx, doc.documentId, actorId);
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.documentId).toBe("INV00000001");
      expect(result.value.state).toBe("posted");

      // A/R debit 1,080 = revenue credit 1,000 + tax credit 80, resolved via
      // the existing sys.revenue.MYR / sys.tax_payable.MYR mappings — no new
      // GL mapping rows.
      expect(await balanceOf(receivablesAccountId)).toBe(1080);
      expect(await balanceOf(revenueAccountId)).toBe(-1000);
      expect(await balanceOf(taxAccountId)).toBe(-80);
      expect(await zeroSum()).toBe(0);
    });

    it("bm09-2 — [CRITICAL] existing Accounts document types are unaffected: a DBN MANUAL_CHARGE still posts directly under the widened doc_type CHECK", async () => {
      const result = await raiseDebitNote(
        {
          financialAccountId,
          billingAccountId,
          netAmount: "500.00",
          taxAmount: null,
          eventAt: EVENT_AT,
          entryDate: EVENT_AT,
          referenceInfo: "bm09 existing-DBN-unchanged guardrail",
        },
        actorId,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.documentId).toMatch(/^DBN\d{8}$/);
      expect(result.value.state).toBe("posted");
      expect(await zeroSum()).toBe(0);
    });

    it("bm09-3 — getPeriodState returns open for the guard period before any bill_run exists", async () => {
      expect(await getPeriodState(GUARD_PERIOD, "MYR")).toBe("open");
    });

    it("bm09-4 — closePeriod returns BILL_RUN_IN_PROGRESS while a bill_run's gl_event_at falls in the period and it isn't COMPLETED/CANCELLED", async () => {
      const [run] = await sql<{ id: string }[]>`
        INSERT INTO billing.bill_run
          (ref_bill_cycle_id, period_start, period_end, scheduled_run_date, status, run_type, gl_event_at)
        VALUES
          (${billCycleId}, '2026-05-01', '2026-05-31', '2026-05-15', 'PROCESSING', 'offCycle', '2026-05-20')
        RETURNING bill_run_id AS id
      `;
      const billRunId = run!.id;

      await sql`
        INSERT INTO billing.customer_bill
          (ref_bill_run_id, ref_billing_account_id, period_partition, category, billing_period_start, billing_period_end, subtotal, tax_total, total_amount, payment_due_date)
        VALUES
          (${billRunId}, ${billingAccountId}, '2026-05-01', 'trial', '2026-05-01', '2026-05-31', '100.00', '0.00', '100.00', '2026-06-15')
      `;

      const result = await closePeriod(GUARD_PERIOD, "MYR", actorId);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("BILL_RUN_IN_PROGRESS");
      if (result.code !== "BILL_RUN_IN_PROGRESS") return;
      expect(result.activeRunIds).toEqual([billRunId]);

      expect(await getPeriodState(GUARD_PERIOD, "MYR")).toBe("open");

      await sql`UPDATE billing.bill_run SET status = 'COMPLETED' WHERE bill_run_id = ${billRunId}`;
    });

    it("bm09-5 — closePeriod succeeds once the run reaches COMPLETED", async () => {
      const result = await closePeriod(GUARD_PERIOD, "MYR", actorId);
      expect(result.ok).toBe(true);
      expect(await getPeriodState(GUARD_PERIOD, "MYR")).toBe("closed");
    });
  },
);
