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
import { billRunInvoices } from "@/db/schema/billing/bill-run-invoices";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { billRunAccountStageRepository } from "@/db/repositories/billing/bill-run-account-stage.repository";
import { seedSysAccounts } from "@/db/seeds/accounts/seed-sys-accounts";
import { seedCoa } from "@/db/seeds/accounts/seed-coa";
import { seedGlMappings } from "@/db/seeds/accounts/seed-gl-mappings";
import { seedReasonCodes } from "@/db/seeds/accounts/seed-reason-codes";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import type { materializeDueRuns as MaterializeDueRuns } from "@/services/billing/materialize-runs";
import type { triggerRun as TriggerRun } from "@/services/billing/trigger-run";
import type { rerunRun as RerunRun } from "@/services/billing/rerun-run";
import type { rejectRun as RejectRun } from "@/services/billing/reject-run";
import type { approveRun as ApproveRun } from "@/services/billing/approve-run";
import type { postRun as PostRun } from "@/services/billing/post-run";
import type {
  rerunDistribution as RerunDistribution,
  recordDistributionOutcome as RecordDistributionOutcome,
  recomputeDistributionStatus as RecomputeDistributionStatus,
} from "@/services/billing/distribute-run";
import type { listAccountBills as ListAccountBills } from "@/services/billing/read/list-account-bills";
import type { listUncharged as ListUncharged } from "@/services/billing/read/list-uncharged";
import type { listErrors as ListErrors } from "@/services/billing/read/list-errors";
import type { listRuns as ListRuns } from "@/services/billing/read/list-runs";
import type { POST as StageCompletePost } from "@/app/api/billrun/[runId]/stage/[stage]/complete/route";

// bm13-spec §3 — the one E2E happy-path journey: materialize → trigger →
// drive stages via the signed M2M endpoints → PROCESSED → review (bills + tax
// + uncharged + errors) → reject a subset (approval blocked) → rerun the
// rejected account (re-process) → approve (a DIFFERENT, four-eyes user) →
// post → INVOICED → DISTRIBUTING → COMPLETED, on synthetic stub figures in a
// clean, isolated test ledger (never production Accounts data). Also folds in
// the bm13-spec §2 "Finalization latch" guardrail — proven against this same
// run's real posted bill rather than rebuilding the fixture a second time —
// and the "next cycle operable at INVOICED" success criterion #10.
//
// bm21-spec §Implementation §2/§4, Phase-2 review folds T3/T8 — extends the
// bm20-era journey (below) with the two legs no single phase-2 unit owned:
// (a) reject → approval-blocked → rerun-rejected → re-process (bm17-spec
// §Implementation §2's model (b), never exercised end-to-end before this
// unit); (b) the D10 safety net (bm19) — a posted account with no stored
// invoice must mandatory-fail distribution rather than let it complete
// silently around the gap, then recover via a (simulated) retry-render +
// Rerun distribution. Both close review-fold gaps the bm13/bm20-era journey
// left open — see this file's tail for (b).
//
// bm20-spec §Design D8/D9 revises the tail of this journey: `postRun` now
// stops at `INVOICED`, then automatically (post-commit) calls
// `triggerDistribution`, which — against the stub engine, synchronously —
// moves the run straight into `DISTRIBUTING` before `postRun` even returns.
// There is no live engine in this environment to deliver the triggered
// artifacts and push a terminal status back, so this journey drives the
// SAME path a real `bill_run_distribution` flow would (`recordDistribution
// Outcome` + `recomputeDistributionStatus`, directly — the M2M route
// handlers themselves are proven by `tests/app/api/billrun-distribution-
// outcome.test.ts`/`billrun-status.test.ts`) to reach `COMPLETED`.
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
    let rejectRun: typeof RejectRun;
    let approveRun: typeof ApproveRun;
    let postRun: typeof PostRun;
    let rerunDistribution: typeof RerunDistribution;
    let recordDistributionOutcome: typeof RecordDistributionOutcome;
    let recomputeDistributionStatus: typeof RecomputeDistributionStatus;
    let REPORT_ARTIFACT_REF: string;
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
      ({ rejectRun } = await import("@/services/billing/reject-run"));
      ({ approveRun } = await import("@/services/billing/approve-run"));
      ({ postRun } = await import("@/services/billing/post-run"));
      ({
        rerunDistribution,
        recordDistributionOutcome,
        recomputeDistributionStatus,
        REPORT_ARTIFACT_REF,
      } = await import("@/services/billing/distribute-run"));
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
        "→ reject → rerun-rejected → approve (four-eyes) → post → " +
        "distribution mandatory-fail → rerun-distribution → COMPLETED",
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
          expect((data as { data: { replayed: boolean } }).data.replayed).toBe(
            false,
          );
        }

        await simulateProcessorTaxation(customerBillId, periodPartition);
        {
          const { status, data } = await stageSignal(runId, "taxation", {
            ban_id: banBilled,
            attempt: 1,
            status: "DONE",
          });
          expect(status).toBe(200);
          expect((data as { data: { replayed: boolean } }).data.replayed).toBe(
            false,
          );
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

        // ---- bm17-spec §Implementation §2, bm21-spec §Implementation §2 —
        // Reject the BILLED account (model (b): the run stays PROCESSED,
        // the operator reruns). ----------------------------------------------
        const rejected = await rejectRun(
          {
            billRunId: runId,
            scope: "selected",
            banIds: [banBilled],
            reason: "E2E ship-gate reject demonstration.",
          },
          approveActorId,
        );
        expect(rejected.ok).toBe(true);
        if (!rejected.ok) return;
        expect(rejected.value.accountCount).toBe(1);

        // The run stays PROCESSED throughout (bm17-spec — no new
        // AccountStatus member; the account's own status is left UNTOUCHED).
        const [runAfterReject] = await db
          .select()
          .from(billRun)
          .where(eq(billRun.billRunId, runId));
        expect(runAfterReject?.status).toBe("PROCESSED");
        const accountAfterReject = await billRunAccountRepository.findStatus(
          db,
          runId,
          banBilled,
        );
        expect(accountAfterReject?.status).toBe("PROCESSED");

        // The rejected account's unposted trial bill is gone (deleteUnposted
        // ForAccounts) and the REJECTED_PENDING_REPROCESS marker is stamped
        // on its latest (current-attempt) stage row.
        const billedBillsAfterReject = await db
          .select()
          .from(customerBill)
          .where(eq(customerBill.refBillingAccountId, banBilled));
        expect(billedBillsAfterReject).toHaveLength(0);
        const rejectedPending =
          await billRunAccountStageRepository.listRejectedPendingForRun(
            db,
            runId,
          );
        expect(rejectedPending.map((r) => r.billingAccountId)).toContain(
          banBilled,
        );

        // ---- `no_rejected_pending` blocks approval until the rejected
        // account is rerun (bm17-spec §Design, the 6th pre-approval check). --
        const blockedApproval = await approveRun(runId, approveActorId);
        expect(blockedApproval.ok).toBe(false);
        if (blockedApproval.ok) return;
        expect(blockedApproval.code).toBe("CHECKS_FAILED");
        if (blockedApproval.code === "CHECKS_FAILED") {
          const noRejectedPending = blockedApproval.checks.find(
            (c) => c.check === "no_rejected_pending",
          );
          expect(noRejectedPending?.pass).toBe(false);
        }

        // ---- Rerun the rejected account: re-claim → re-process, from
        // Validation (its trial bill was deleted by reject). ----------------
        const rerun = await rerunRun(
          {
            billRunId: runId,
            accountIds: [banBilled],
            fromStage: "validation",
            reason: "E2E ship-gate rerun-rejected demonstration.",
          },
          triggerActorId,
        );
        expect(rerun.ok).toBe(true);
        if (!rerun.ok) return;
        expect(rerun.value.accountCount).toBe(1);
        expect(rerun.value.attempt).toBe(2);

        // Drive the full six-stage pipeline again at the new attempt (the
        // engine does not auto-resignal in v1, rerun-run.ts §5) — same
        // write-then-signal shape as the account's first pass above.
        for (const stage of ["validation", "collection"]) {
          const { status } = await stageSignal(runId, stage, {
            ban_id: banBilled,
            attempt: 2,
            status: "DONE",
          });
          expect(status).toBe(200);
        }
        const reagg = await simulateProcessorAggregation({
          runId,
          banId: banBilled,
          periodStart: "2026-06-01",
          periodEnd: "2026-06-30",
          paymentDueDate: "2026-08-01",
        });
        {
          const { status } = await stageSignal(runId, "aggregation", {
            ban_id: banBilled,
            attempt: 2,
            status: "DONE",
          });
          expect(status).toBe(200);
        }
        await simulateProcessorTaxation(
          reagg.customerBillId,
          reagg.periodPartition,
        );
        {
          const { status } = await stageSignal(runId, "taxation", {
            ban_id: banBilled,
            attempt: 2,
            status: "DONE",
          });
          expect(status).toBe(200);
        }
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

        // The re-processed attempt's stage row carries no
        // REJECTED_PENDING_REPROCESS marker — `no_rejected_pending` reads
        // ONLY the account's CURRENT-attempt row (bm17-spec Phase-2 review
        // fold T6), and the attempt bump above already makes the marked
        // (attempt-1) row stale.
        const rejectedPendingAfterRerun =
          await billRunAccountStageRepository.listRejectedPendingForRun(
            db,
            runId,
          );
        expect(
          rejectedPendingAfterRerun.map((r) => r.billingAccountId),
        ).not.toContain(banBilled);

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

        // ---- bm20-spec §Design D8/D9, §Implementation §5 — posting stops at
        // INVOICED; `triggerDistribution` then fires automatically
        // (post-commit), and — against the stub engine, synchronously —
        // moves the run straight into DISTRIBUTING before `postRun` returns.
        const [invoicedRun] = await db
          .select()
          .from(billRun)
          .where(eq(billRun.billRunId, runId));
        expect(invoicedRun?.status).toBe("DISTRIBUTING");
        expect(invoicedRun?.invoicedAt).not.toBeNull();
        expect(invoicedRun?.completedAt).toBeNull();
        expect(invoicedRun?.distributionExecutionId).toBeTruthy();

        // ---- Drive distribution the same way the deployed
        // `bill_run_distribution` flow would: record the loopback's
        // DELIVERED outcome for every mandatory artifact the automatic
        // trigger actually launched, then the flow's `finally` handler's
        // terminal push (`recomputeDistributionStatus`, invoked by
        // `handle-status-push.ts` in production — called directly here since
        // there is no live engine in this environment to fire the real
        // push). This environment has no reachable blob store / Chromium
        // (see the render-pending assertions below), so `banBilled`'s render
        // never produced a `bill_run_invoices` row by the time
        // `triggerDistribution` ran — the ONLY mandatory artifact it saw is
        // the per-run report CSV.
        const distributionAttempt = invoicedRun!.distributionAttempt ?? 1;
        const reportOutcome = await recordDistributionOutcome({
          runId,
          target: "loopback",
          artifactRef: REPORT_ARTIFACT_REF,
          artifactType: "report_csv",
          isMandatory: true,
          outcome: "DELIVERED",
          attempt: distributionAttempt,
        });
        expect(reportOutcome.replayed).toBe(false);

        await db.transaction((tx) =>
          recomputeDistributionStatus(tx, { billRunId: runId }),
        );

        // ---- bm21-spec §Implementation §2, Phase-2 review fold T8 — "assert
        // the D10 safety net end-to-end": `banBilled` is POSTED but has no
        // stored `bill_run_invoices` row (no reachable blob store/Chromium in
        // this environment, same gap as bm19's Outstanding notes). Every
        // mandatory artifact the trigger actually launched (the report) WAS
        // delivered — the pre-D10-safety-net behavior would have let this
        // silently reach COMPLETED around the gap (see the OLD assertion this
        // replaces, kept only in history). `recomputeDistributionStatus`'s
        // `hasUnrenderedPostedAccounts` check (services/billing/
        // distribute-run.ts) now refuses to complete around it —
        // DISTRIBUTION_FAILED, never a silent COMPLETED.
        const [mandatoryFailRun] = await db
          .select()
          .from(billRun)
          .where(eq(billRun.billRunId, runId));
        expect(mandatoryFailRun?.status).toBe("DISTRIBUTION_FAILED");
        expect(mandatoryFailRun?.invoicedAt).not.toBeNull();
        expect(mandatoryFailRun?.completedAt).toBeNull();

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
        //
        // bm19-spec §Design "Posting reads real udr_rated (Inv #3)" — the
        // checksum is now `md5(...)` over the account's claimed
        // `rating.udr_rated` rows for `(run, ban, posted_attempt)`, computed
        // in SQL. This fixture never inserts any `rating.udr_rated` rows for
        // `banBilled` (no rating-engine fixture exists in this synthetic
        // journey), so the claimed set is empty and the checksum degrades to
        // `md5('')` — still a deterministic, truthy 32-char hex string, so
        // the `toBeTruthy()` assertion below is unaffected either way; this
        // is NOT a proof that the checksum tracks real charge lines (that
        // proof belongs to a rating-integrated fixture once one exists).
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

        // ---- bm19-spec §Phase-2 review folds T5 [P1] — the structural
        // one-INV-per-bill latch: `postAccount` stamped the real posted INV's
        // `ref_customer_bill_id`/`period_partition`, and `document`'s new
        // partial UNIQUE index (0037_document_customer_bill_latch.sql)
        // refuses any SECOND document row referencing the same bill —
        // proven directly (a duplicate posted-INV race is otherwise hard to
        // provoke through the service layer alone, which is the whole point
        // of the DB-level backstop).
        expect(billedDocs[0]?.refCustomerBillId).toBe(
          finalizedBill.customerBillId,
        );
        await expect(
          sql!`
            INSERT INTO billing.document
              (document_id, doc_type, state, ref_financial_account_id,
               reason_code, currency, total_amount, entry_date,
               reference_info, event_at, created_by, last_edited_by,
               ref_customer_bill_id, period_partition)
            VALUES
              ('INV99999999', 'INV', 'draft',
               (SELECT ref_financial_account_id FROM billing.document WHERE document_id = ${billedDocs[0]!.documentId}),
               'STANDARD_INVOICE',
               (SELECT currency FROM billing.document WHERE document_id = ${billedDocs[0]!.documentId}),
               '1.00', now(),
               'duplicate-latch-probe', now(), ${approveActorId}, ${approveActorId},
               ${finalizedBill.customerBillId}, ${finalizedBill.periodPartition})
          `,
        ).rejects.toThrow(/duplicate key value violates unique constraint/i);

        // ---- bm19-spec §Design D10 — the post-commit render/store step.
        // This environment has neither a reachable blob store
        // (BILLRUN_BLOB_CONNECTION_STRING/_ACCOUNT_URL unset here) nor
        // Playwright's Chromium installed, so `renderAndStoreInvoice`'s
        // internal try/catch swallows that failure exactly as designed — the
        // account is left "render-pending": no `bill_run_invoices` row exists
        // yet, self-documenting the tolerated, retryable gap (never a stored
        // column, D10) — and, per the D10 safety net above, distribution is
        // now stuck at DISTRIBUTION_FAILED rather than silently COMPLETED.
        const renderPendingRows = await db
          .select()
          .from(billRunInvoices)
          .where(eq(billRunInvoices.refBillingAccountId, banBilled));
        expect(renderPendingRows).toHaveLength(0);

        // ---- bm21-spec §Implementation §2, T8 — "retry-render + rerun-
        // distribution reaches COMPLETED". `retryRenderInvoice` itself needs
        // real Chromium/blob storage (unavailable here — same environmental
        // gap noted throughout this module's Outstanding notes), so this
        // simulates its OUTCOME the same way `simulateProcessorAggregation`/
        // `simulateProcessorTaxation` stand in for the processor's writes: a
        // direct insert of the `bill_run_invoices` row `retryRenderInvoice`
        // would have produced. This same row doubles as the immutability
        // guard's proof (bm19-spec §Design "The stored PDF is the issued
        // record — immutable", migration 0036_bill_run_invoices.sql) — once
        // written, a row can never be UPDATEd or DELETEd.
        const [syntheticInvoice] = await sql!<
          { bill_run_invoice_id: string }[]
        >`
          INSERT INTO billing.bill_run_invoices
            (ref_bill_run_id, ref_billing_account_id, ref_customer_bill_id,
             ref_inv_document_id, blob_ref, checksum, period_partition)
          VALUES
            (${runId}, ${banBilled}, ${finalizedBill.customerBillId},
             ${finalizedBill.refInvDocumentId}, 'invoices/test/synthetic.pdf',
             'synthetic-checksum', ${finalizedBill.periodPartition})
          RETURNING bill_run_invoice_id
        `;
        expect(syntheticInvoice?.bill_run_invoice_id).toBeTruthy();
        await expect(
          sql!`UPDATE billing.bill_run_invoices SET checksum = 'tampered' WHERE bill_run_invoice_id = ${syntheticInvoice!.bill_run_invoice_id}`,
        ).rejects.toThrow(/immutable/i);
        await expect(
          sql!`DELETE FROM billing.bill_run_invoices WHERE bill_run_invoice_id = ${syntheticInvoice!.bill_run_invoice_id}`,
        ).rejects.toThrow(/immutable/i);

        // ---- Rerun distribution: now that the (simulated) retry-render
        // produced a stored invoice, `rerunDistribution` picks it up as a
        // never-before-attempted mandatory artifact (services/billing/
        // distribute-run.ts's `neverAttemptedInvoices`, bm21-spec T8) even
        // though it was never part of a FAILED outcome row — the D10 safety
        // net above never fabricated one, it derived the gap structurally.
        const rerunDist = await rerunDistribution(runId, approveActorId);
        expect(rerunDist.ok).toBe(true);
        if (!rerunDist.ok) return;
        expect(rerunDist.value.attempt).toBe(2);
        expect(rerunDist.value.artifactCount).toBe(1);

        const [redistributingRun] = await db
          .select()
          .from(billRun)
          .where(eq(billRun.billRunId, runId));
        expect(redistributingRun?.status).toBe("DISTRIBUTING");
        expect(redistributingRun?.distributionAttempt).toBe(2);

        // The loopback delivers the now-stored invoice under the new round.
        const invoiceOutcome = await recordDistributionOutcome({
          runId,
          target: "loopback",
          artifactRef: syntheticInvoice!.bill_run_invoice_id,
          artifactType: "invoice_pdf",
          isMandatory: true,
          outcome: "DELIVERED",
          attempt: 2,
        });
        expect(invoiceOutcome.replayed).toBe(false);

        await db.transaction((tx) =>
          recomputeDistributionStatus(tx, { billRunId: runId }),
        );

        const [completedRun] = await db
          .select()
          .from(billRun)
          .where(eq(billRun.billRunId, runId));
        expect(completedRun?.status).toBe("COMPLETED");
        expect(completedRun?.invoicedAt).not.toBeNull();
        expect(completedRun?.completedAt).not.toBeNull();

        // ---- Next-cycle operability keys off INVOICED, not COMPLETED
        // (overview success criterion #10, bm20-spec §Design D8/D9). This run
        // DID pass through an observable INVOICED window before
        // `triggerDistribution` moved it into DISTRIBUTING (asserted above) —
        // the point of keying next-cycle operability off INVOICED rather than
        // COMPLETED is exactly so a slow/stuck distribution round never holds
        // up next month. This run has since reached COMPLETED too, so both
        // this run's terminal status and the next period's operability are
        // proven here. --------
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
