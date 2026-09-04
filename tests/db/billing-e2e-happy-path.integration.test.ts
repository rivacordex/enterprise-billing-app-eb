import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import { organization, partyRole } from "@/db/schema/customer";
import { billCycle } from "@/db/schema/billing/catalogs";
import { financialAccount, billingAccount } from "@/db/schema/billing/accounts";
import { billRun } from "@/db/schema/billing/bill-run";
import { customerBill } from "@/db/schema/billing/customer-bill";
import { customerBillTaxItem } from "@/db/schema/billing/customer-bill-tax-item";
import { document } from "@/db/schema/billing/documents";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { seedSysAccounts } from "@/db/seeds/accounts/seed-sys-accounts";
import { seedCoa } from "@/db/seeds/accounts/seed-coa";
import { seedGlMappings } from "@/db/seeds/accounts/seed-gl-mappings";
import { seedReasonCodes } from "@/db/seeds/accounts/seed-reason-codes";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import type { materializeDueRuns as MaterializeDueRuns } from "@/services/billing/materialize-runs";
import type { triggerRun as TriggerRun } from "@/services/billing/trigger-run";
import type { rerunRun as RerunRun } from "@/services/billing/rerun-run";
import type { approveRun as ApproveRun } from "@/services/billing/approve-run";
import type { postRun as PostRun } from "@/services/billing/post-run";
import type { listAccountBills as ListAccountBills } from "@/services/billing/read/list-account-bills";
import type { listUncharged as ListUncharged } from "@/services/billing/read/list-uncharged";
import type { listErrors as ListErrors } from "@/services/billing/read/list-errors";
import type { listRuns as ListRuns } from "@/services/billing/read/list-runs";
import type { POST as StageCompletePost } from "@/app/api/billrun/[runId]/stage/[stage]/complete/route";

// bm13-spec §3 — the one E2E happy-path journey: materialize → trigger →
// drive stages via the signed M2M endpoints → PROCESSED → review (bills + tax
// + uncharged + errors) → rerun a subset → approve (a DIFFERENT, four-eyes
// user) → post → INVOICED → COMPLETED, on synthetic stub figures in a clean,
// isolated test ledger (never production Accounts data). Also folds in the
// bm13-spec §2 "Finalization latch" guardrail — proven against this same
// run's real posted bill rather than rebuilding the fixture a second time —
// and the "next cycle operable at INVOICED" success criterion #10.
//
// bm16-spec §Design "The M2M handler becomes record-only (D5)" — Phase 2
// moves Aggregation/Taxation's bill-data WRITE off the app and onto the bill
// run processor (`billrun_runtime`, write-then-signal D6); this journey has
// no live engine in this environment, so `simulateProcessorAggregation`/
// `simulateProcessorTaxation` below stand in for that processor write,
// issued immediately BEFORE the corresponding stage signal — exactly the
// write-then-signal order the real processor follows. The M2M endpoint
// itself only records the signal; it computes and writes nothing (proven by
// `tests/services/billing/handle-stage-signal.test.ts`).
//
// Three accounts carry the run's three distinct outcomes: BILLED (the full
// six-stage pipeline, incl. a mid-run rerun of a later stage), FAILED (a HARD
// aggregation failure → PROCESSING_FAILED → SKIPPED at approval, consuming no
// invoice number), and EXCLUDED. `EXCLUDED` is force-set directly on the
// snapshot row after `triggerRun` rather than built through a full
// order/offering/product-inventory fixture chain to earn a genuine
// partial-period exclusion at Scoping — the partial-period PREDICATE itself
// (`isPartialPeriod`) is already unit-tested (`tests/services/billing/
// partial-period.test.ts`) and integration-proven at Scoping
// (`tests/services/billing/scope-accounts.test.ts`); this test instead proves
// the DOWNSTREAM behavior of an `EXCLUDED` account (never billed, marked
// `SKIPPED` at approval, consumes no invoice number, listed on Uncharged).
const databaseUrl = process.env.DATABASE_URL;
const CURRENCY = "MYR";
const SERVICE_TOKEN = "e2e-ship-gate-service-token-".padEnd(40, "x");

describe.skipIf(!databaseUrl)(
  "bm13 E2E happy-path journey (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql | undefined;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let materializeDueRuns: typeof MaterializeDueRuns;
    let triggerRun: typeof TriggerRun;
    let rerunRun: typeof RerunRun;
    let approveRun: typeof ApproveRun;
    let postRun: typeof PostRun;
    let listAccountBills: typeof ListAccountBills;
    let listUncharged: typeof ListUncharged;
    let listErrors: typeof ListErrors;
    let listRuns: typeof ListRuns;
    let stageCompletePost: typeof StageCompletePost;

    let triggerActorId: string;
    let approveActorId: string;
    let cycleId: string;

    async function newAppUser(name: string): Promise<string> {
      const [row] = await db
        .insert(appuser)
        .values({
          id: crypto.randomUUID(),
          userName: name,
          userEmail: `${crypto.randomUUID()}@example.invalid`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        })
        .returning({ id: appuser.id });
      return row!.id;
    }

    async function newBillingAccount(name: string): Promise<string> {
      const [org] = await db
        .insert(organization)
        .values({
          name: `BM13E2E-${name}-Customer`,
          organizationType: "COMPANY",
          status: "ACTIVE",
          lastModifiedBy: triggerActorId,
        })
        .returning({ organizationId: organization.organizationId });
      const [role] = await db
        .insert(partyRole)
        .values({
          engagedParty: org!.organizationId,
          status: "ACTIVE",
          lastModifiedBy: triggerActorId,
        })
        .returning({ partyRoleId: partyRole.partyRoleId });
      const [fa] = await db
        .insert(financialAccount)
        .values({
          name: `BM13E2E-${name}-FA`,
          refPartyRoleId: role!.partyRoleId,
          currency: CURRENCY,
          lastEditedBy: triggerActorId,
        })
        .returning({ financialAccountId: financialAccount.financialAccountId });
      const [ban] = await db
        .insert(billingAccount)
        .values({
          name: `BM13E2E-${name}-BAN`,
          state: "active",
          refPartyRoleId: role!.partyRoleId,
          refFinancialAccountId: fa!.financialAccountId,
          currency: CURRENCY,
          refBillCycleId: cycleId,
          lastEditedBy: triggerActorId,
        })
        .returning({ billingAccountId: billingAccount.billingAccountId });
      return ban!.billingAccountId;
    }

    // bm16-spec §Design "Write-then-signal (D6)" — stands in for the bill run
    // processor's own write, issued immediately before the matching stage
    // signal below (no live engine in this environment; see file header).
    // Synthetic fixed figures, mirroring the retired `deriveStubSubtotal`
    // shape — the exact numbers are not asserted, only that a bill/tax item
    // exists for the review + approve/post legs of the journey.
    async function simulateProcessorAggregation(input: {
      runId: string;
      banId: string;
      periodStart: string;
      periodEnd: string;
      paymentDueDate: string;
    }): Promise<{ customerBillId: string; periodPartition: string }> {
      const [row] = await db
        .insert(customerBill)
        .values({
          refBillRunId: input.runId,
          refBillingAccountId: input.banId,
          periodPartition: input.periodStart,
          category: "trial",
          state: "new",
          billingPeriodStart: input.periodStart,
          billingPeriodEnd: input.periodEnd,
          subtotal: "100.00",
          taxTotal: "0.00",
          totalAmount: "100.00",
          paymentDueDate: input.paymentDueDate,
        })
        .returning({
          customerBillId: customerBill.customerBillId,
          periodPartition: customerBill.periodPartition,
        });
      return row!;
    }

    async function simulateProcessorTaxation(
      customerBillId: string,
      periodPartition: string,
    ): Promise<void> {
      await db.insert(customerBillTaxItem).values({
        refCustomerBillId: customerBillId,
        periodPartition,
        taxCategory: "GST",
        taxRate: "8.00",
        taxAmount: "8.00",
      });
      await db
        .update(customerBill)
        .set({ taxTotal: "8.00", totalAmount: "108.00" })
        .where(
          and(
            eq(customerBill.customerBillId, customerBillId),
            eq(customerBill.periodPartition, periodPartition),
          ),
        );
    }

    // Drives the signed M2M stage-completion endpoint itself (the actual
    // Route Handler function, bearer-authenticated) rather than calling
    // `handleStageSignal` directly — this is the literal "signed M2M
    // endpoints" the spec asks the journey to be driven through.
    async function stageSignal(
      runId: string,
      stage: string,
      body: {
        ban_id: string;
        attempt: number;
        status: string;
        error_class?: string;
        error_code?: string;
        error_detail?: string;
      },
    ): Promise<{ status: number; data: unknown }> {
      const request = new Request(
        `http://localhost/api/billrun/${runId}/stage/${stage}/complete`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${SERVICE_TOKEN}`,
          },
          body: JSON.stringify(body),
        },
      );
      const response = await stageCompletePost(request, {
        params: Promise.resolve({ runId, stage }),
      });
      const data = (await response.json()) as unknown;
      return { status: response.status, data };
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      // Set before any module that transitively loads `lib/config.ts` is
      // imported — the config schema is validated eagerly on first import.
      process.env.BILLRUN_APP_TOKEN = SERVICE_TOKEN;

      sql = postgres(databaseUrl as string, { max: 5 });
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      // The Accounts GL fixture stack — the app's own production seed
      // functions (`db:seed-accounts`), not hand-rolled SQL: system accounts,
      // chart of accounts, GL mappings (incl. `sys.revenue.MYR`/
      // `sys.tax_payable.MYR`, resolved by the pre-approval GL check and by
      // `postDocument`), and the `STANDARD_INVOICE` INV reason code
      // (unlimited `autoPostLimit`, bm09). Every seed helper is idempotent.
      await seedSysAccounts(db);
      await seedCoa(db);
      await seedGlMappings(db);
      await seedReasonCodes(db);

      ({ materializeDueRuns } =
        await import("@/services/billing/materialize-runs"));
      ({ triggerRun } = await import("@/services/billing/trigger-run"));
      ({ rerunRun } = await import("@/services/billing/rerun-run"));
      ({ approveRun } = await import("@/services/billing/approve-run"));
      ({ postRun } = await import("@/services/billing/post-run"));
      ({ listAccountBills } =
        await import("@/services/billing/read/list-account-bills"));
      ({ listUncharged } =
        await import("@/services/billing/read/list-uncharged"));
      ({ listErrors } = await import("@/services/billing/read/list-errors"));
      ({ listRuns } = await import("@/services/billing/read/list-runs"));
      ({ POST: stageCompletePost } =
        await import("@/app/api/billrun/[runId]/stage/[stage]/complete/route"));

      triggerActorId = await newAppUser("BM13E2E-trigger-operator");
      approveActorId = await newAppUser("BM13E2E-approve-operator");
      const [cycle] = await db
        .insert(billCycle)
        .values({ name: "BM13E2E Cycle", lastEditedBy: null })
        .returning({ billCycleId: billCycle.billCycleId });
      cycleId = cycle!.billCycleId;
    }, 120_000);

    afterAll(async () => {
      if (!sql) return;
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    it(
      "materialize → trigger → stage signals → PROCESSED → review " +
        "→ rerun → approve (four-eyes) → post → COMPLETED",
      async () => {
        // ---- Fixtures: three accounts, three distinct run outcomes. -------
        const banBilled = await newBillingAccount("Billed");
        const banFailed = await newBillingAccount("Failed");
        const banExcluded = await newBillingAccount("Excluded");

        // Materialize the due run rather than inserting it directly — this is
        // the journey's first leg (spec §3: "materialize → trigger → …"). The
        // test cycle is monthly with the default `cycle_day = 1`, so at business
        // day 2026-07-01 the single due in-arrears period is June (period
        // 2026-06-01 → 2026-06-30, run date 2026-07-01), created SCHEDULED.
        await materializeDueRuns("2026-07-01");
        const [run] = await db
          .select({
            billRunId: billRun.billRunId,
            status: billRun.status,
            periodEnd: billRun.periodEnd,
            scheduledRunDate: billRun.scheduledRunDate,
          })
          .from(billRun)
          .where(
            and(
              eq(billRun.refBillCycleId, cycleId),
              eq(billRun.periodStart, "2026-06-01"),
            ),
          );
        expect(run).toBeDefined();
        expect(run?.status).toBe("SCHEDULED");
        expect(run?.periodEnd).toBe("2026-06-30");
        expect(run?.scheduledRunDate).toBe("2026-07-01");
        const runId = run!.billRunId;

        // ---- Trigger: snapshot the cycle's three active accounts. --------
        const triggered = await triggerRun(runId, triggerActorId, "2026-07-01");
        expect(triggered.ok).toBe(true);
        if (!triggered.ok) return;
        expect(triggered.value.banCount).toBe(3);
        expect(triggered.value.excludedCount).toBe(0);

        // Force-flip the EXCLUDED account's snapshot row (see file header
        // comment) — simulates a partial-period exclusion Scoping would have
        // produced, without a full order/offering/product-inventory chain.
        await billRunAccountRepository.updateStatus(db, runId, banExcluded, {
          status: "EXCLUDED",
          errorCode: "PARTIAL_PERIOD",
          errorDetail: "Simulated for the E2E ship-gate journey.",
        });

        // ---- Drive the BILLED account through all six stages, attempt 1. -
        for (const stage of ["validation", "collection"]) {
          const { status, data } = await stageSignal(runId, stage, {
            ban_id: banBilled,
            attempt: 1,
            status: "DONE",
          });
          expect(status).toBe(200);
          expect((data as { data: { replayed: boolean } }).data.replayed).toBe(
            false,
          );
        }

        // Write-then-signal (bm16-spec D6): the processor's aggregation write,
        // simulated, immediately before the matching signal.
        const { customerBillId, periodPartition } =
          await simulateProcessorAggregation({
            runId,
            banId: banBilled,
            periodStart: "2026-06-01",
            periodEnd: "2026-06-30",
            paymentDueDate: "2026-08-01",
          });
        {
          const { status, data } = await stageSignal(runId, "aggregation", {
            ban_id: banBilled,
            attempt: 1,
            status: "DONE",
          });
          expect(status).toBe(200);
          expect(
            (data as { data: { replayed: boolean } }).data.replayed,
          ).toBe(false);
        }

        await simulateProcessorTaxation(customerBillId, periodPartition);
        {
          const { status, data } = await stageSignal(runId, "taxation", {
            ban_id: banBilled,
            attempt: 1,
            status: "DONE",
          });
          expect(status).toBe(200);
          expect(
            (data as { data: { replayed: boolean } }).data.replayed,
          ).toBe(false);
        }

        const verify1 = await stageSignal(runId, "verification", {
          ban_id: banBilled,
          attempt: 1,
          status: "DONE",
        });
        expect(verify1.status).toBe(200);
        expect(
          (verify1.data as { data: { accountStatus: string } }).data
            .accountStatus,
        ).toBe("PROCESSED");

        // Idempotency/replay guardrail (code-standards §9.2), proven inline:
        // resending the exact same (run, ban, stage, attempt) signal is a
        // 200 no-op, not a second write.
        const replay = await stageSignal(runId, "verification", {
          ban_id: banBilled,
          attempt: 1,
          status: "DONE",
        });
        expect(replay.status).toBe(200);
        expect(
          (replay.data as { data: { replayed: boolean } }).data.replayed,
        ).toBe(true);

        // ---- Drive the FAILED account: validation/collection DONE, then a
        // HARD aggregation failure (pass-through, not app-overridden) —
        // PROCESSING_FAILED, never billed, never signalled further. --------
        for (const stage of ["validation", "collection"]) {
          const { status } = await stageSignal(runId, stage, {
            ban_id: banFailed,
            attempt: 1,
            status: "DONE",
          });
          expect(status).toBe(200);
        }
        const hardFailure = await stageSignal(runId, "aggregation", {
          ban_id: banFailed,
          attempt: 1,
          status: "FAILED",
          error_class: "HARD",
          error_code: "SIMULATED_HARD_FAILURE",
          error_detail: "E2E ship-gate simulated aggregation failure.",
        });
        expect(hardFailure.status).toBe(200);
        expect(
          (hardFailure.data as { data: { accountStatus: string } }).data
            .accountStatus,
        ).toBe("PROCESSING_FAILED");

        // ---- The run recomputed to PROCESSED: every account is now
        // terminal (PROCESSED / PROCESSING_FAILED / EXCLUDED). -------------
        const [processedRun] = await db
          .select()
          .from(billRun)
          .where(eq(billRun.billRunId, runId));
        expect(processedRun?.status).toBe("PROCESSED");

        // ---- Review: bills + tax, uncharged, errors. ----------------------
        const bills = await listAccountBills(runId);
        expect(bills).toHaveLength(1);
        expect(bills[0]?.billingAccountId).toBe(banBilled);
        expect(bills[0]?.category).toBe("trial");
        expect(bills[0]?.taxItems.length).toBeGreaterThan(0);

        const uncharged = await listUncharged(runId);
        expect(uncharged).toHaveLength(1);
        expect(uncharged[0]?.billingAccountId).toBe(banExcluded);
        expect(uncharged[0]?.reason).toBe("PARTIAL_PERIOD");
        expect(uncharged[0]?.indicativeValue).toBeNull();

        const errors = await listErrors(runId);
        expect(errors).toHaveLength(1);
        expect(errors[0]?.billingAccountId).toBe(banFailed);
        expect(errors[0]?.errorClass).toBe("HARD");
        expect(errors[0]?.stage).toBe("aggregation");

        // ---- Rerun a subset: the BILLED account only, from Taxation. -----
        const rerun = await rerunRun(
          {
            billRunId: runId,
            accountIds: [banBilled],
            fromStage: "taxation",
            reason: "E2E ship-gate rerun demonstration.",
          },
          triggerActorId,
        );
        expect(rerun.ok).toBe(true);
        if (!rerun.ok) return;
        expect(rerun.value.accountCount).toBe(1);
        expect(rerun.value.attempt).toBe(2);

        // Drive the re-signalled stages at the new attempt (the engine does
        // not auto-resignal in v1, rerun-run.ts §5).
        const retax = await stageSignal(runId, "taxation", {
          ban_id: banBilled,
          attempt: 2,
          status: "DONE",
        });
        expect(retax.status).toBe(200);
        const reverify = await stageSignal(runId, "verification", {
          ban_id: banBilled,
          attempt: 2,
          status: "DONE",
        });
        expect(reverify.status).toBe(200);
        expect(
          (reverify.data as { data: { accountStatus: string } }).data
            .accountStatus,
        ).toBe("PROCESSED");

        const [reprocessedRun] = await db
          .select()
          .from(billRun)
          .where(eq(billRun.billRunId, runId));
        expect(reprocessedRun?.status).toBe("PROCESSED");

        // ---- Approve: a DIFFERENT user — four-eyes. -------------------------
        const approved = await approveRun(runId, approveActorId);
        expect(approved.ok).toBe(true);
        if (!approved.ok) return;
        expect(approved.value.skippedCount).toBe(2); // FAILED + EXCLUDED

        const [approvedRun] = await db
          .select()
          .from(billRun)
          .where(eq(billRun.billRunId, runId));
        expect(approvedRun?.status).toBe("APPROVED");
        expect(approvedRun?.approvedBy).toBe(approveActorId);

        // ---- Post: one INV for the sole billed account. -------------------
        const posted = await postRun(runId, approveActorId);
        expect(posted.ok).toBe(true);
        if (!posted.ok) return;
        expect(posted.value.results).toHaveLength(1);
        expect(posted.value.results[0]?.billingAccountId).toBe(banBilled);
        expect(posted.value.results[0]?.result.status).toBe("invoiced");
        expect(posted.value.completed).toBe(true);

        const [completedRun] = await db
          .select()
          .from(billRun)
          .where(eq(billRun.billRunId, runId));
        expect(completedRun?.status).toBe("COMPLETED");
        expect(completedRun?.invoicedAt).not.toBeNull();
        expect(completedRun?.completedAt).not.toBeNull();

        // ---- Exactly one INV per billed account; SKIPPED/EXCLUDED consume
        // no invoice number. ------------------------------------------------
        const billedDocs = await db
          .select()
          .from(document)
          .where(
            and(
              eq(document.refBillingAccountId, banBilled),
              eq(document.docType, "INV"),
            ),
          );
        expect(billedDocs).toHaveLength(1);
        expect(billedDocs[0]?.state).toBe("posted");

        const failedDocs = await db
          .select()
          .from(document)
          .where(eq(document.refBillingAccountId, banFailed));
        expect(failedDocs).toHaveLength(0);
        const excludedDocs = await db
          .select()
          .from(document)
          .where(eq(document.refBillingAccountId, banExcluded));
        expect(excludedDocs).toHaveLength(0);

        // No billing-side charge copy (Inv. #3): the finalized bill carries
        // only the checksum anchor, never a copy of the charge lines. FAILED
        // and EXCLUDED accounts never got a customer_bill row at all.
        const billedBillRows = await db
          .select()
          .from(customerBill)
          .where(eq(customerBill.refBillingAccountId, banBilled));
        expect(billedBillRows).toHaveLength(1);
        const finalizedBill = billedBillRows[0]!;
        expect(finalizedBill.category).toBe("normal");
        expect(finalizedBill.refInvDocumentId).toBe(billedDocs[0]?.documentId);
        expect(finalizedBill.chargeChecksum).toBeTruthy();

        const failedBillRows = await db
          .select()
          .from(customerBill)
          .where(eq(customerBill.refBillingAccountId, banFailed));
        expect(failedBillRows).toHaveLength(0);
        const excludedBillRows = await db
          .select()
          .from(customerBill)
          .where(eq(customerBill.refBillingAccountId, banExcluded));
        expect(excludedBillRows).toHaveLength(0);

        // ---- Finalization latch (bm13-spec §2, architecture Inv. #4
        // [CRITICAL], migration 0033): a customer_bill with
        // ref_inv_document_id set cannot be deleted OR updated — enforced by
        // the DB trigger, not merely the service layer's own guarded writes.
        await expect(
          sql!`DELETE FROM billing.customer_bill WHERE customer_bill_id = ${finalizedBill.customerBillId} AND period_partition = ${finalizedBill.periodPartition}`,
        ).rejects.toThrow(/finalized/i);
        await expect(
          sql!`UPDATE billing.customer_bill SET subtotal = '0.00' WHERE customer_bill_id = ${finalizedBill.customerBillId} AND period_partition = ${finalizedBill.periodPartition}`,
        ).rejects.toThrow(/finalized/i);
        // Still intact after both rejected attempts.
        const [stillFinalized] = await db
          .select()
          .from(customerBill)
          .where(eq(customerBill.refBillingAccountId, banBilled));
        expect(stillFinalized?.refInvDocumentId).toBe(
          finalizedBill.refInvDocumentId,
        );
        expect(stillFinalized?.subtotal).toBe(finalizedBill.subtotal);

        // ---- Next-cycle operability keys off INVOICED, not COMPLETED
        // (overview success criterion #10). In v1 `POSTING` completes
        // straight to `COMPLETED` — `invoiced_at`/`completed_at` are stamped
        // in the SAME write (`completePosting`) because `DISTRIBUTING` is
        // never entered — so there is no observable window where a run is
        // INVOICED but not yet COMPLETED; both this run's terminal status
        // (COMPLETED, not blocking) and the next period's operability are
        // what the criterion actually cashes out to in this release. --------
        await materializeDueRuns("2026-08-02");
        const nextCyclePage = await listRuns(
          { tab: "current", cycleId, status: null, page: 1 },
          { today: "2026-08-02" },
        );
        const nextRun = nextCyclePage.rows.find(
          (r) => r.periodStart === "2026-07-01",
        );
        expect(nextRun).toBeDefined();
        expect(nextRun?.status).toBe("SCHEDULED");
        expect(nextRun?.operable).toBe(true);
      },
      120_000,
    );
  },
);
