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

// ac11-spec §3.6 v04-cash-conservation.property.test.ts
// V4 conservation identity: Σ_captured − Σ_net_allocated = −unapplied_balance
// where Σ_net_allocated = Σ_allocations − Σ_reversed_allocations.
// This invariant must hold after every individual operation in any arbitrary
// sequence of captures, allocations, and allocation reversals. It is a
// double-entry accounting invariant: any implementation bug that misbooks a
// leg or misses a stamp will cause it to drift.
const databaseUrl = process.env.DATABASE_URL;

const EVENT_AT = new Date("2026-05-01T00:00:00.000Z");

/** Parses a decimal-string amount to integer cents for exact arithmetic. */
function toCents(amount: string): bigint {
  const negative = amount.startsWith("-");
  const abs = negative ? amount.slice(1) : amount;
  const [wholePart, fracPart = "00"] = abs.split(".");
  const absCents =
    BigInt(wholePart ?? "0") * 100n +
    BigInt(fracPart.padEnd(2, "0").slice(0, 2));
  return negative ? -absCents : absCents;
}

/** Converts integer cents to a decimal-string amount ("123" → "1.23"). */
function fromCents(cents: bigint): string {
  const abs = cents < 0n ? -cents : cents;
  const sign = cents < 0n ? "-" : "";
  return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}

describe.skipIf(!databaseUrl)(
  "V4 — cash conservation across arbitrary capture/allocate/reverse sequences (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let testDb: Database;
    let creatorId: string;
    let financialAccountId: string;
    let billingAccountId: string;
    let unappliedAccountId: string;

    // Running totals tracked across ALL property runs (the identity is
    // cumulative and must hold after every individual step, not just at the
    // end of each property run).
    let totalCapturedCents = 0n;
    let totalNetAllocatedCents = 0n;

    async function unappliedBalance(): Promise<bigint> {
      const [row] = await sql<{ balance: string }[]>`
        SELECT balance::text AS balance
        FROM billing.pgledger_accounts_view
        WHERE id = ${unappliedAccountId}
      `;
      return toCents(row?.balance ?? "0.00");
    }

    async function zeroSum(): Promise<bigint> {
      const [row] = await sql<{ total: string | null }[]>`
        SELECT coalesce(sum(balance), 0)::text AS total
        FROM billing.pgledger_accounts_view
      `;
      return toCents(row?.total ?? "0.00");
    }

    /** Verify the V4 conservation identity and V1 zero-sum at the current point. */
    async function assertConservation(label: string): Promise<void> {
      const uc = await unappliedBalance();
      // V4: Σ_captured − Σ_net_allocated = −unapplied_balance
      // (unapplied_cash is credit-normal: balance is negative when holding funds)
      const lhs = totalCapturedCents - totalNetAllocatedCents;
      const rhs = -uc;
      expect(
        lhs,
        `V4 identity at [${label}]: lhs=${fromCents(lhs)} rhs=${fromCents(rhs)}`,
      ).toBe(rhs);
      // V1: every posted transfer balances to zero across all accounts.
      expect(await zeroSum(), `V1 zero-sum at [${label}]`).toBe(0n);
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
      testDb = drizzle(sql, { schema }) as unknown as Database;

      const [creator] = await sql<{ id: string }[]>`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES ('test-v04-creator', 'V04 Creator', 'v04-creator@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id
      `;
      creatorId = creator!.id;

      await sql`SELECT id FROM billing.pgledger_create_account('sys.cash.MYR', 'MYR')`;
      await sql`SELECT id FROM billing.pgledger_create_account('sys.revenue.MYR', 'MYR')`;

      await sql`
        INSERT INTO billing.gl_account (gl_code, name, account_class, normal_balance, is_postable)
        VALUES ('1000', 'Cash', 'asset', 'debit', true),
               ('4100', 'Revenue', 'revenue', 'credit', true)
      `;
      await sql`
        INSERT INTO billing.gl_mapping (selector_type, selector, currency, ref_gl_code)
        VALUES ('system_account', 'sys.cash.MYR',    'MYR', '1000'),
               ('system_account', 'sys.revenue.MYR', 'MYR', '4100')
      `;

      await sql`
        INSERT INTO billing.reason_code (reason_code, doc_type, posting_nature, auto_post_limit, state)
        VALUES
          ('CUST_PAYMENT',  'PAY', 'cash',    999999.00, 'active'),
          ('MANUAL_CHARGE', 'DBN', 'revenue', 999999.00, 'active')
      `;

      const [cycle] = await sql<{ id: string }[]>`
        INSERT INTO billing.bill_cycle (name, frequency, cycle_day, payment_due_days, state)
        VALUES ('V04 Monthly', 'monthly', 1, 30, 'active')
        RETURNING bill_cycle_id AS id
      `;

      const [org] = await sql<{ id: string }[]>`
        INSERT INTO customer.organization (name, organization_type, last_modified_by)
        VALUES ('V04 Test Corp', 'COMPANY', ${creatorId})
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
          statusReason: "V04 test",
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
        WHERE owner_type = 'financial_account' AND owner_id = ${financialAccountId} AND ledger_role = 'unapplied_cash'
      `;
      unappliedAccountId = ucRow!.pgledger_account_id;

      // Initial state: no captures yet → identity holds trivially (0 − 0 = −0).
      totalCapturedCents = 0n;
      totalNetAllocatedCents = 0n;
      await assertConservation("initial");
    }, 60_000);

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    it("V4 property: fc.assert that conservation holds after every capture, allocate, and reverse step", async () => {
      // Property: given any sequence of (amount_cents, reverseIt) pairs,
      // the conservation identity holds after each individual operation.
      // Amounts are in integer cents (10–5000 MYR range) to avoid
      // floating-point rounding in the test assertions.
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              // Amount in cents (100–500000 = 1.00–5000.00 MYR).
              amountCents: fc.bigInt({ min: 100n, max: 500000n }),
              // Whether to reverse the allocation after posting.
              shouldReverse: fc.boolean(),
            }),
            { minLength: 1, maxLength: 4 },
          ),
          async (steps) => {
            for (const step of steps) {
              const amount = fromCents(step.amountCents);

              // Capture — moves sys.cash → unapplied_cash.
              const cap = await capturePayment(
                {
                  financialAccountId,
                  reasonCode: "CUST_PAYMENT",
                  amount,
                  payment_mode: "bank_transfer",
                  mode_ref: { bankRef: `V04-CAP-${Date.now()}` },
                  eventAt: EVENT_AT,
                  referenceDate: EVENT_AT,
                  referenceInfo: `V4 cap ${amount}`,
                },
                creatorId,
              );
              expect(cap.ok, `capture ${amount} failed`).toBe(true);
              totalCapturedCents += step.amountCents;
              await assertConservation(`after capture ${amount}`);

              // Raise DBN to generate A/R (needed before allocation).
              const dbn = await raiseDebitNote(
                {
                  financialAccountId,
                  billingAccountId,
                  netAmount: amount,
                  taxAmount: null,
                  eventAt: EVENT_AT,
                  referenceDate: EVENT_AT,
                  referenceInfo: `V4 dbn ${amount}`,
                },
                creatorId,
              );
              expect(dbn.ok, `raiseDebitNote ${amount} failed`).toBe(true);
              // DBN does not affect unapplied — conservation identity unchanged.
              await assertConservation(`after DBN ${amount}`);

              // Allocate — moves unapplied_cash → receivables.
              const alloc = await allocatePayment(
                {
                  financialAccountId,
                  billingAccountId,
                  amount,
                  refSettledDocumentId: null,
                  eventAt: EVENT_AT,
                  referenceDate: EVENT_AT,
                  referenceInfo: `V4 alloc ${amount}`,
                },
                creatorId,
              );
              expect(alloc.ok, `allocate ${amount} failed`).toBe(true);
              totalNetAllocatedCents += step.amountCents;
              await assertConservation(`after allocation ${amount}`);

              if (step.shouldReverse && alloc.ok) {
                const lines = await documentLineRepository.findByDocumentId(
                  testDb,
                  alloc.value.documentId,
                );
                const allocDoc = await documentRepository.findById(
                  testDb,
                  alloc.value.documentId,
                );
                if (lines[0] && allocDoc) {
                  // Reverse the allocation line — moves receivables → unapplied_cash.
                  const rev = await reverseLine(
                    {
                      originalDocumentId: alloc.value.documentId,
                      financialAccountId,
                      selectedLineIds: [lines[0].documentLineId],
                      reversalComment: `V4 reversal ${amount}`,
                      eventAt: EVENT_AT,
                      referenceDate: EVENT_AT,
                      referenceInfo: `V4 rev-ref ${amount}`,
                      lastModified: allocDoc.lastModified,
                    },
                    creatorId,
                  );
                  expect(rev.ok, `reverse ${amount} failed`).toBe(true);
                  totalNetAllocatedCents -= step.amountCents;
                  await assertConservation(`after reversal ${amount}`);
                }
              }
            }
          },
        ),
        // numRuns: 5 with fixed seed keeps CI time bounded (each run
        // triggers 3–12 DB round-trips) while giving non-trivial coverage.
        { numRuns: 5, seed: 1234 },
      );
    }, 120_000);

    it("V4 deterministic: full cycle (capture → allocate → reverse → re-allocate) satisfies identity at every step", async () => {
      const amount = "250.00";
      const amountCents = toCents(amount);

      // Capture.
      const cap = await capturePayment(
        {
          financialAccountId,
          reasonCode: "CUST_PAYMENT",
          amount,
          payment_mode: "cash",
          mode_ref: { receiptNo: "V04-DET-001" },
          eventAt: EVENT_AT,
          referenceDate: EVENT_AT,
          referenceInfo: "V4 det capture",
        },
        creatorId,
      );
      expect(cap.ok).toBe(true);
      totalCapturedCents += amountCents;
      await assertConservation("det: after capture");

      // Raise DBN.
      await raiseDebitNote(
        {
          financialAccountId,
          billingAccountId,
          netAmount: amount,
          taxAmount: null,
          eventAt: EVENT_AT,
          referenceDate: EVENT_AT,
          referenceInfo: "V4 det dbn",
        },
        creatorId,
      );
      await assertConservation("det: after DBN");

      // Allocate.
      const alloc1 = await allocatePayment(
        {
          financialAccountId,
          billingAccountId,
          amount,
          refSettledDocumentId: null,
          eventAt: EVENT_AT,
          referenceDate: EVENT_AT,
          referenceInfo: "V4 det alloc 1",
        },
        creatorId,
      );
      expect(alloc1.ok).toBe(true);
      totalNetAllocatedCents += amountCents;
      await assertConservation("det: after alloc 1");

      if (!alloc1.ok) return;

      // Reverse alloc 1.
      const lines1 = await documentLineRepository.findByDocumentId(
        testDb,
        alloc1.value.documentId,
      );
      const doc1 = await documentRepository.findById(
        testDb,
        alloc1.value.documentId,
      );
      const rev1 = await reverseLine(
        {
          originalDocumentId: alloc1.value.documentId,
          financialAccountId,
          selectedLineIds: [lines1[0]!.documentLineId],
          reversalComment: "V4 det reversal 1",
          eventAt: EVENT_AT,
          referenceDate: EVENT_AT,
          referenceInfo: "V4 det rev-ref 1",
          lastModified: doc1!.lastModified,
        },
        creatorId,
      );
      expect(rev1.ok).toBe(true);
      totalNetAllocatedCents -= amountCents;
      await assertConservation("det: after reversal 1");

      // Re-raise DBN (the original was settled by the reversal restoring A/R —
      // we need fresh A/R to allocate again).
      await raiseDebitNote(
        {
          financialAccountId,
          billingAccountId,
          netAmount: amount,
          taxAmount: null,
          eventAt: EVENT_AT,
          referenceDate: EVENT_AT,
          referenceInfo: "V4 det dbn 2",
        },
        creatorId,
      );
      await assertConservation("det: after DBN 2");

      // Re-allocate.
      const alloc2 = await allocatePayment(
        {
          financialAccountId,
          billingAccountId,
          amount,
          refSettledDocumentId: null,
          eventAt: EVENT_AT,
          referenceDate: EVENT_AT,
          referenceInfo: "V4 det alloc 2",
        },
        creatorId,
      );
      expect(alloc2.ok).toBe(true);
      totalNetAllocatedCents += amountCents;
      await assertConservation("det: after alloc 2 (settled — final)");
    });

    it("V4 boundary: unapplied at zero (all captured funds fully allocated, not reversed) still satisfies identity", async () => {
      const ucBefore = await unappliedBalance();
      // If any unapplied is outstanding, allocate it out to bring unapplied → 0.
      if (ucBefore !== 0n) {
        const allocAmount = fromCents(-ucBefore); // unapplied is credit-normal negative
        await raiseDebitNote(
          {
            financialAccountId,
            billingAccountId,
            netAmount: allocAmount,
            taxAmount: null,
            eventAt: EVENT_AT,
            referenceDate: EVENT_AT,
            referenceInfo: "V4 boundary settle",
          },
          creatorId,
        );
        const alloc = await allocatePayment(
          {
            financialAccountId,
            billingAccountId,
            amount: allocAmount,
            refSettledDocumentId: null,
            eventAt: EVENT_AT,
            referenceDate: EVENT_AT,
            referenceInfo: "V4 boundary alloc",
          },
          creatorId,
        );
        if (alloc.ok) {
          totalNetAllocatedCents += toCents(allocAmount);
        }
      }
      // Now unapplied should be 0.
      const ucAfter = await unappliedBalance();
      expect(ucAfter).toBe(0n);
      await assertConservation("boundary: unapplied zero");
    });
  },
);
