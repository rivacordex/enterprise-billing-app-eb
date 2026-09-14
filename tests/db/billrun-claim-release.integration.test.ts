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
import { udrRated } from "@/db/schema/rating/udr-rated";
import { billRunAccountStageRepository } from "@/db/repositories/billing/bill-run-account-stage.repository";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import type { materializeDueRuns as MaterializeDueRuns } from "@/services/billing/materialize-runs";
import type { triggerRun as TriggerRun } from "@/services/billing/trigger-run";
import type { rejectRun as RejectRun } from "@/services/billing/reject-run";
import type { rerunRun as RerunRun } from "@/services/billing/rerun-run";
import type { cancelRun as CancelRun } from "@/services/billing/cancel-run";
import type { POST as StageCompletePost } from "@/app/api/billrun/[runId]/stage/[stage]/complete/route";

// bm24-spec §Implementation §5 — the DB-gated regression proving that ALL
// THREE abandon paths (reject, cancel, rerun) release claimed `rating.udr_rated`
// rows back to `RATED` with the four claim columns NULLed, so no `BILL_DRAFT`
// row can survive an abandoned attempt to become unclaimable once Collection
// narrows to `RATED` only (bm27, Inv #19 / D21).
//
// This is the counterpart of `billing-e2e-happy-path.integration.test.ts`,
// which drives the ship-gate journey but (deliberately) inserts NO
// `rating.udr_rated` rows — so it can prove the reject/rerun LIFECYCLE but not
// the actual `udr_rated` release. This focused suite inserts real rated rows,
// simulates the bill-run processor's Collection claim (`RATED → BILL_DRAFT`
// with the four claim columns set — the same write `billrun_runtime` performs
// under bm14's grant), then drives each abandon path and asserts the release.
//
// Each scenario provisions its OWN bill cycle + one billing account so
// `triggerRun` snapshots exactly that account (isolation across scenarios).
// No Accounts GL / posting fixtures are needed — none of the three paths post.
const databaseUrl = process.env.DATABASE_URL;
const CURRENCY = "MYR";
const SERVICE_TOKEN = "bm24-claim-release-service-token-".padEnd(40, "x");

// Physical partition of every rated row below — start_datetime lives in June
// 2026, so `rating.period_of()` (the table CHECK's own derivation) buckets it
// to the June partition. The exact value is asserted only indirectly.
const RATED_START = "2026-06-10T00:00:00.000Z";
const RATED_END = "2026-06-10T01:00:00.000Z";

describe.skipIf(!databaseUrl)(
  "bm24 claim release on reject / cancel / rerun (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql | undefined;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let materializeDueRuns: typeof MaterializeDueRuns;
    let triggerRun: typeof TriggerRun;
    let rejectRun: typeof RejectRun;
    let rerunRun: typeof RerunRun;
    let cancelRun: typeof CancelRun;
    let stageCompletePost: typeof StageCompletePost;

    let triggerActorId: string;
    let approveActorId: string;

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

    // A fresh cycle + one active billing account on it — no ledger wiring
    // (these paths never post). Returns the ban + a durable subscriber ref the
    // rated rows below key off (the account linkage that SURVIVES a release —
    // `billrun_ban_id` is a claim column and is NULLed on release, so the
    // re-claim simulation must match on the subscriber ref, exactly as the
    // real Collection stage would).
    async function newCycleAccount(
      label: string,
    ): Promise<{ cycleId: string; ban: string; subRef: string }> {
      const [cycle] = await db
        .insert(billCycle)
        .values({ name: `BM24-${label} Cycle`, lastEditedBy: null })
        .returning({ billCycleId: billCycle.billCycleId });
      const cycleId = cycle!.billCycleId;

      const [org] = await db
        .insert(organization)
        .values({
          name: `BM24-${label}-Customer`,
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
          name: `BM24-${label}-FA`,
          refPartyRoleId: role!.partyRoleId,
          currency: CURRENCY,
          lastEditedBy: triggerActorId,
        })
        .returning({ financialAccountId: financialAccount.financialAccountId });
      const [ban] = await db
        .insert(billingAccount)
        .values({
          name: `BM24-${label}-BAN`,
          state: "active",
          refPartyRoleId: role!.partyRoleId,
          refFinancialAccountId: fa!.financialAccountId,
          currency: CURRENCY,
          refBillCycleId: cycleId,
          lastEditedBy: triggerActorId,
        })
        .returning({ billingAccountId: billingAccount.billingAccountId });

      return {
        cycleId,
        ban: ban!.billingAccountId,
        subRef: `bm24-sub-${ban!.billingAccountId}`,
      };
    }

    // Materialize + trigger the single June run for a freshly-provisioned
    // cycle. At business day 2026-07-01 the due in-arrears period is June
    // (2026-06-01 → 2026-06-30). `triggerRun` snapshots the cycle's one active
    // account and moves the run to PROCESSING (stub engine — no live engine in
    // this environment).
    async function provisionRun(
      cycleId: string,
    ): Promise<{ runId: string; periodStart: string; periodEnd: string }> {
      await materializeDueRuns("2026-07-01");
      const [run] = await db
        .select({
          billRunId: billRun.billRunId,
          periodStart: billRun.periodStart,
          periodEnd: billRun.periodEnd,
        })
        .from(billRun)
        .where(
          and(
            eq(billRun.refBillCycleId, cycleId),
            eq(billRun.periodStart, "2026-06-01"),
          ),
        );
      expect(run).toBeDefined();
      const triggered = await triggerRun(
        run!.billRunId,
        triggerActorId,
        "2026-07-01",
      );
      expect(triggered.ok).toBe(true);
      if (!triggered.ok) throw new Error("trigger failed");
      expect(triggered.value.banCount).toBe(1);
      return {
        runId: run!.billRunId,
        periodStart: run!.periodStart,
        periodEnd: run!.periodEnd,
      };
    }

    // Insert `count` UNCLAIMED rated rows for one account (status RATED, all
    // four claim columns NULL). `udr_key` varies by sequence so the live-row
    // UNIQUE (partition_period, start_datetime, udr_key, is_live) never
    // collides. Returns the generated udr_ids in insertion order.
    async function insertRatedRows(
      subRef: string,
      count: number,
    ): Promise<string[]> {
      const ids: string[] = [];
      for (let seq = 0; seq < count; seq++) {
        const [row] = await sql!<{ udr_id: string }[]>`
          INSERT INTO rating.udr_rated
            (partition_period, udr_type, start_datetime, end_datetime, status,
             udr_subscriber_ref_id, udr_key, udr_usage_quantity, udr_usage_unit,
             udr_rate_type, udr_rated_price, udr_rated_price_raw,
             udr_rounding_mode, udr_currency, udr_ref_batch_id, udr_source_file,
             rating_engine_version, rating_flow_revision)
          VALUES
            (rating.period_of(${RATED_START}::timestamptz),
             'SUBSCRIPTION_RECURRING', ${RATED_START}::timestamptz,
             ${RATED_END}::timestamptz, 'RATED', ${subRef},
             ${`bm24-key-${subRef}-${seq}`}, '1.000000', 'EA', 'FLAT',
             '10.00', '10.00', 'HALF_UP', ${CURRENCY}, '_BM24_BATCH',
             '_BM24', '_BM24', 0)
          RETURNING udr_id
        `;
        ids.push(row!.udr_id);
      }
      return ids;
    }

    // Simulate the bill-run processor's Collection claim (RATED → BILL_DRAFT,
    // stamping the four claim columns) — the same write `billrun_runtime`
    // performs under bm14's grant boundary. `udrIds` omitted ⇒ claim every
    // RATED row for the subscriber (a full re-claim); passed ⇒ claim only
    // those rows (a PARTIAL claim, leaving the rest RATED).
    async function claimRows(
      runId: string,
      ban: string,
      subRef: string,
      attempt: number,
      udrIds?: string[],
    ): Promise<number> {
      const rows = await sql!<{ udr_id: string }[]>`
        UPDATE rating.udr_rated
        SET status = 'BILL_DRAFT',
            billrun_ref_id = ${runId},
            billrun_ban_id = ${ban},
            billrun_attempt = ${attempt},
            billrun_checksum = 'bm24-claim-checksum',
            upsert_datetime = now()
        WHERE udr_subscriber_ref_id = ${subRef}
          AND status = 'RATED'
          ${udrIds ? sql!`AND udr_id = ANY(${udrIds})` : sql!``}
        RETURNING udr_id
      `;
      return rows.length;
    }

    async function ratedRowsFor(subRef: string) {
      return db
        .select({
          udrId: udrRated.udrId,
          status: udrRated.status,
          billrunRefId: udrRated.billrunRefId,
          billrunBanId: udrRated.billrunBanId,
          billrunAttempt: udrRated.billrunAttempt,
          billrunChecksum: udrRated.billrunChecksum,
        })
        .from(udrRated)
        .where(eq(udrRated.udrSubscriberRefId, subRef));
    }

    // Drive one M2M stage-completion signal through the real signed Route
    // Handler (matching the happy-path suite's `stageSignal`).
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
      return { status: response.status, data: await response.json() };
    }

    // The processor's aggregation write (a trial customer_bill), simulated —
    // issued immediately before the matching stage signal (write-then-signal,
    // bm16-spec D6). Only reject needs one (to prove it is deleted).
    async function simulateTrialBill(
      runId: string,
      ban: string,
      periodStart: string,
      periodEnd: string,
    ): Promise<void> {
      await db.insert(customerBill).values({
        refBillRunId: runId,
        refBillingAccountId: ban,
        periodPartition: periodStart,
        category: "trial",
        state: "new",
        billingPeriodStart: periodStart,
        billingPeriodEnd: periodEnd,
        subtotal: "100.00",
        taxTotal: "0.00",
        totalAmount: "100.00",
        paymentDueDate: "2026-08-01",
      });
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

      ({ materializeDueRuns } =
        await import("@/services/billing/materialize-runs"));
      ({ triggerRun } = await import("@/services/billing/trigger-run"));
      ({ rejectRun } = await import("@/services/billing/reject-run"));
      ({ rerunRun } = await import("@/services/billing/rerun-run"));
      ({ cancelRun } = await import("@/services/billing/cancel-run"));
      ({ POST: stageCompletePost } =
        await import("@/app/api/billrun/[runId]/stage/[stage]/complete/route"));

      triggerActorId = await newAppUser("BM24-trigger-operator");
      approveActorId = await newAppUser("BM24-approve-operator");
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
      "[CRITICAL] no claim survives an abandoned attempt: a partial " +
        "PROCESSING_FAILED then rerun leaves NO BILL_DRAFT row, and the whole " +
        "charge set is re-claimable (bm24-spec §5)",
      async () => {
        const { cycleId, ban, subRef } = await newCycleAccount("Rerun");
        const { runId } = await provisionRun(cycleId);

        // Three rated charges for the account; the first attempt claims only
        // TWO (a partial claim), then the account HARD-fails at aggregation
        // with no complete bill — leaving two BILL_DRAFT rows stranded.
        const udrIds = await insertRatedRows(subRef, 3);
        for (const stage of ["validation", "collection"]) {
          const { status } = await stageSignal(runId, stage, {
            ban_id: ban,
            attempt: 1,
            status: "DONE",
          });
          expect(status).toBe(200);
        }
        const claimed = await claimRows(runId, ban, subRef, 1, [
          udrIds[0]!,
          udrIds[1]!,
        ]);
        expect(claimed).toBe(2);

        const hardFailure = await stageSignal(runId, "aggregation", {
          ban_id: ban,
          attempt: 1,
          status: "FAILED",
          error_class: "HARD",
          error_code: "BM24_SIMULATED_PARTIAL_FAILURE",
          error_detail: "Partial claim, no complete bill.",
        });
        expect(hardFailure.status).toBe(200);
        expect(
          (hardFailure.data as { data: { accountStatus: string } }).data
            .accountStatus,
        ).toBe("PROCESSING_FAILED");

        // Two rows stranded at BILL_DRAFT under attempt 1 before the rerun.
        const beforeRerun = await ratedRowsFor(subRef);
        expect(
          beforeRerun.filter((r) => r.status === "BILL_DRAFT"),
        ).toHaveLength(2);

        // Rerun the account — release-before-retrigger drains the stranded
        // rows back to RATED.
        const rerun = await rerunRun(
          {
            billRunId: runId,
            accountIds: [ban],
            fromStage: "validation",
            reason: "bm24 partial-failure rerun regression.",
          },
          triggerActorId,
        );
        expect(rerun.ok).toBe(true);
        if (!rerun.ok) return;
        expect(rerun.value.attempt).toBe(2);

        // [CRITICAL] No BILL_DRAFT row survives from the prior attempt: all
        // three rows are back at RATED with the four claim columns NULL.
        const afterRerun = await ratedRowsFor(subRef);
        expect(afterRerun).toHaveLength(3);
        for (const row of afterRerun) {
          expect(row.status).toBe("RATED");
          expect(row.billrunRefId).toBeNull();
          expect(row.billrunBanId).toBeNull();
          expect(row.billrunAttempt).toBeNull();
          expect(row.billrunChecksum).toBeNull();
        }

        // …and the re-triggered processor (simulated) re-claims the COMPLETE
        // set of three — not the partial two — so the re-run bill would carry
        // every charge the first attempt claimed (bm24-spec §5 [CRITICAL]).
        const reclaimed = await claimRows(runId, ban, subRef, 2);
        expect(reclaimed).toBe(3);
      },
      120_000,
    );

    it(
      "reject releases the rejected account's rows to RATED (four claim " +
        "columns NULL, NOT REJECTED), deletes its trial bill, and the marker " +
        "bars approval (bm24-spec §5)",
      async () => {
        const { cycleId, ban, subRef } = await newCycleAccount("Reject");
        const { runId, periodStart, periodEnd } = await provisionRun(cycleId);

        // Two rated charges, claimed, and a trial bill — then drive the
        // account all the way to PROCESSED so it is reject-eligible.
        await insertRatedRows(subRef, 2);
        for (const stage of ["validation", "collection"]) {
          expect(
            (
              await stageSignal(runId, stage, {
                ban_id: ban,
                attempt: 1,
                status: "DONE",
              })
            ).status,
          ).toBe(200);
        }
        await claimRows(runId, ban, subRef, 1);
        await simulateTrialBill(runId, ban, periodStart, periodEnd);
        for (const stage of ["aggregation", "taxation"]) {
          expect(
            (
              await stageSignal(runId, stage, {
                ban_id: ban,
                attempt: 1,
                status: "DONE",
              })
            ).status,
          ).toBe(200);
        }
        const verify = await stageSignal(runId, "verification", {
          ban_id: ban,
          attempt: 1,
          status: "DONE",
        });
        expect(
          (verify.data as { data: { accountStatus: string } }).data
            .accountStatus,
        ).toBe("PROCESSED");

        // Both rows claimed to BILL_DRAFT before the reject.
        expect(
          (await ratedRowsFor(subRef)).filter((r) => r.status === "BILL_DRAFT"),
        ).toHaveLength(2);

        const rejected = await rejectRun(
          {
            billRunId: runId,
            scope: "selected",
            banIds: [ban],
            reason: "bm24 reject-release regression.",
          },
          approveActorId,
        );
        expect(rejected.ok).toBe(true);

        // Released to RATED with all four claim columns NULL — NOT REJECTED.
        const afterReject = await ratedRowsFor(subRef);
        expect(afterReject).toHaveLength(2);
        for (const row of afterReject) {
          // RATED (the bm24 release), never the old `→ REJECTED` flip —
          // asserting `toBe("RATED")` proves both (the two are distinct single
          // values, so a regression to REJECTED fails this line).
          expect(row.status).toBe("RATED");
          expect(row.billrunRefId).toBeNull();
          expect(row.billrunBanId).toBeNull();
          expect(row.billrunAttempt).toBeNull();
          expect(row.billrunChecksum).toBeNull();
        }

        // The unposted trial bill is gone…
        const billsAfter = await db
          .select()
          .from(customerBill)
          .where(eq(customerBill.refBillingAccountId, ban));
        expect(billsAfter).toHaveLength(0);

        // …and the REJECTED_PENDING_REPROCESS marker (not `udr_status`) bars
        // approval until the account is reprocessed.
        const rejectedPending =
          await billRunAccountStageRepository.listRejectedPendingForRun(
            db,
            runId,
          );
        expect(rejectedPending.map((r) => r.billingAccountId)).toContain(ban);
      },
      120_000,
    );

    it(
      "cancel releases the whole run's claimed rows to RATED (bm24-spec §5 — " +
        "verified unchanged: cancel already conforms)",
      async () => {
        const { cycleId, ban, subRef } = await newCycleAccount("Cancel");
        const { runId } = await provisionRun(cycleId);

        // Claim every rated charge, then cancel the PROCESSING run.
        await insertRatedRows(subRef, 2);
        await claimRows(runId, ban, subRef, 1);
        expect(
          (await ratedRowsFor(subRef)).filter((r) => r.status === "BILL_DRAFT"),
        ).toHaveLength(2);

        const cancelled = await cancelRun(runId, triggerActorId);
        expect(cancelled.ok).toBe(true);

        const afterCancel = await ratedRowsFor(subRef);
        expect(afterCancel).toHaveLength(2);
        for (const row of afterCancel) {
          expect(row.status).toBe("RATED");
          expect(row.billrunRefId).toBeNull();
          expect(row.billrunBanId).toBeNull();
          expect(row.billrunAttempt).toBeNull();
          expect(row.billrunChecksum).toBeNull();
        }
      },
      120_000,
    );
  },
);
