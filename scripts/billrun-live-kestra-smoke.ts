import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { and, desc, eq, inArray, lte, ne } from "drizzle-orm";

import { db } from "@/db/client";
import { billCycle } from "@/db/schema/billing/catalogs";
import { billRun } from "@/db/schema/billing/bill-run";
import { billRunAccount } from "@/db/schema/billing/bill-run-account";
import { billingAccount } from "@/db/schema/billing/accounts";
import { customerBill } from "@/db/schema/billing/customer-bill";
import { organization, partyRole } from "@/db/schema/customer";
import { productInventory } from "@/db/schema/inventory";
import { udrRated } from "@/db/schema/rating/udr-rated";
import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { billRunAccountStageRepository } from "@/db/repositories/billing/bill-run-account-stage.repository";
import { DEFAULT_BILL_CYCLE_NAME } from "@/db/seeds/accounts/seed-bill-cycles";
import { getOrCreateAppUser } from "@/db/seeds/lib/get-or-create-appuser";
import {
  billRunDistributionForceFail,
  billRunProcessingForceFail,
  billRunStallThresholdMinutes,
  isBillRunEngineConfigured,
} from "@/lib/config";
import { logger } from "@/lib/logger";
import { materializeDueRuns } from "@/services/billing/materialize-runs";
import { scopeAccounts } from "@/services/billing/scope-accounts";
import { triggerRun } from "@/services/billing/trigger-run";
import { reconcileRun } from "@/services/billing/reconcile-run";
import { rejectRun } from "@/services/billing/reject-run";
import { rerunRun } from "@/services/billing/rerun-run";
import { approveRun } from "@/services/billing/approve-run";
import { postRun } from "@/services/billing/post-run";
import { rerunDistribution } from "@/services/billing/distribute-run";
import { isStalled } from "@/services/billing/stall";
import { getBusinessToday } from "@/services/billing/business-today";
import type { RunStatus } from "@/types/billing";

// bm37-spec §Design/§Implementation. The live-Kestra END-TO-END lifecycle
// assertion — supersedes the bm21 "trigger -> claim -> PROCESSED" smoke. With
// bm36's signal-back real (a run drives itself to PROCESSED, a HARD account
// settles via the terminal signal), this script now proves the WHOLE operator
// journey against the REALLY DEPLOYED `bill_run_processing` +
// `bill_run_distribution` flows on a real `billrun` Kestra engine — the one
// thing the CI-doubled E2E (`tests/db/billing-e2e-happy-path.integration.test.ts`)
// can never prove — and closes the bm16/bm20 live-Kestra gate open since Phase 2.
//
// It is NOT part of the DB-gated CI suite: a deliberately off-by-default script
// (wired to the `billrun_live_kestra_smoke` Azure Pipelines stage,
// `runBillrunLiveKestraSmoke` param, default false). The `_SAMPLE_` seed
// provenance gate below is the sole safety boundary keeping it off real billing
// data; it refuses to "pass" against the stub engine (fails loud, not a silent
// skip) so a misconfigured run can never be mistaken for a met exit criterion.
//
// Prerequisite: `db:seed-sample` (the `ci` profile) has seeded the `_SAMPLE_*`
// scenario against the `DEFAULT_BILL_CYCLE_NAME` cycle in the target database,
// and `BILLRUN_ENGINE_URL`/`BILLRUN_ENGINE_AUTH`/`BILLRUN_ENGINE_NAMESPACE`
// (`lib/config.ts`) point at that real, deployed namespace.
//
// ── Why this script re-spawns itself as sequenced legs ──────────────────────
// The two failure injections bm37 drives — `BILLRUN_PROCESSING_FORCE_FAIL`
// (bm36) and `BILLRUN_DISTRIBUTION_FORCE_FAIL` (bm20) — are resolved ONCE per
// process into module-level `const`s (`lib/config.ts`), read by
// `trigger-run.ts` / `distribute-run.ts` when they build the flow payload. A
// single process therefore cannot flip them mid-run. So the journey needs THREE
// distinct force-fail configurations, and each runs in its own child process
// (this same file, re-invoked with `SMOKE_LEG` set), orchestrated in sequence:
//   1. `proc-fail`  (PROC_FF=on,  DIST_FF=off): trigger -> a forced account
//      settles to PROCESSING_FAILED via the terminal signal; the run recomputes
//      to PROCESSED (bm37 decision (a): the established, tested
//      `compute-run-status` contract — a mixed PROCESSED/PROCESSING_FAILED
//      terminal set derives PROCESSED, the failed account SKIPPED at approval —
//      NOT run-level PROCESSING_FAILED, which only a whole-execution FAILED/KILL
//      yields). Hands the run id off to the next leg.
//   2. `drive`      (PROC_FF=off, DIST_FF=on): rerun-recover the forced account
//      -> PROCESSED; reject a billed account (marker set, approval blocked) ->
//      rerun-reprocess -> PROCESSED; approve (four-eyes, a second actor); post
//      -> INVOICED -> the auto-launched distribution force-fails to
//      DISTRIBUTION_FAILED.
//   3. `redist`     (DIST_FF=off): rerun distribution -> COMPLETED.
// The `ci` seed exposes exactly ONE due period, so the whole journey runs on the
// SAME bill run rather than two calendar-distinct runs (the spec's "Run A / Run
// B" split) — the failure injections are still sequenced so no run is ever
// simultaneously reject-blocked and processing-failed, which is the property the
// two-run split exists to guarantee.

const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 10 * 60_000;

// The seeded `_SAMPLE_` customer's registration number and the provenance-marker
// prefix its udr_rated factory stamps. These MUST stay in lockstep with their
// canonical definitions — `SAMPLE_REGISTRATION_NUMBER` in
// `db/seeds/sample/seed-billrun-sample.ts` and the `_SAMPLE_` sentinel in
// `db/seeds/sample/udr-rated-sample.ts` (`SAMPLE_PROVENANCE_SENTINEL`,
// stamped onto udrSourceFile/udrRefBatchId/ratingEngineVersion). They are
// redeclared here rather than imported because the seed runs its own `main()`
// on import and the udr-rated factory is import-restricted to `db/seeds/sample/**`
// — so the whole safety gate hinges on these two literals matching the seed.
const SAMPLE_REGISTRATION_NUMBER = "_SAMPLE_-BILLRUN-0001";
const SAMPLE_MARKER = /^_SAMPLE_/;

// The two four-eyes-distinct actors. Stable names/emails so `getOrCreateAppUser`
// resolves the SAME row across all three leg processes — the approver must be a
// different user than the trigger actor for the four-eyes gate to pass.
const TRIGGER_ACTOR = {
  name: "billrun-live-kestra-smoke",
  email: "billrun-live-kestra-smoke@example.invalid",
} as const;
const APPROVE_ACTOR = {
  name: "billrun-live-kestra-smoke-approver",
  email: "billrun-live-kestra-smoke-approver@example.invalid",
} as const;

type SmokeLeg = "proc-fail" | "drive" | "redist";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertEngineConfigured(): void {
  if (!isBillRunEngineConfigured) {
    throw new Error(
      "billrun-live-kestra-smoke: BILLRUN_ENGINE_URL/BILLRUN_ENGINE_AUTH " +
        "are not set to a real engine — this smoke gate refuses to run " +
        "against the STUB client (that would prove nothing about a real " +
        "deployed flow). Configure a real `billrun` Kestra namespace first " +
        "(workflow-management/flows/bill-run-processor/README.md's Repo/Owner/Deploy-step exit criterion).",
    );
  }
}

// ── Safety gate (bm21-spec §Implementation §1, code-standards §9 item 16;
// rescoped bm33 D31; bm37 extends it to cover the new mutating steps) ─────────
// This script drives REAL, irreversible bill-run mutations (trigger, reject,
// rerun, approve, post, distribute) against whatever DATABASE_URL points at.
// With `BILLRUN_PLACEHOLDER_MODE` retired (bm33), seed provenance is the sole
// remaining safety boundary: before ANY leg mutates, prove the run can only ever
// touch the unmistakably-fake `_SAMPLE_` seed graph (bm15):
//   1. every account the run scopes must belong to the seeded
//      `_SAMPLE_-BILLRUN-0001` customer, and
//   2. every candidate `udr_rated` charge must carry the `_SAMPLE_` markers.
// Any deviation means DATABASE_URL is pointed at real billing data — abort
// loudly. Re-run at the head of every mutating leg (approve/post consume invoice
// numbers), so a mid-journey misconfiguration can never slip past a gate that
// only guarded the trigger.
async function scopedBanIds(
  run: {
    billRunId: string;
    periodStart: string;
    periodEnd: string;
    status: string;
  },
  cycleId: string,
): Promise<string[]> {
  // A SCHEDULED run has no snapshot yet — derive the scope the trigger WOULD
  // take. Once triggered, the authoritative scope is the `bill_run_account`
  // snapshot the trigger froze.
  if (run.status === "SCHEDULED") {
    const { pending, excluded } = await scopeAccounts(db, {
      billRunId: run.billRunId,
      refBillCycleId: cycleId,
      periodStart: run.periodStart,
      periodEnd: run.periodEnd,
    });
    return [...pending, ...excluded].map((r) => r.refBillingAccountId);
  }
  const rows = await db
    .select({ ban: billRunAccount.refBillingAccountId })
    .from(billRunAccount)
    .where(eq(billRunAccount.refBillRunId, run.billRunId));
  return rows.map((r) => r.ban);
}

async function assertSampleOnlyScope(
  run: {
    billRunId: string;
    periodStart: string;
    periodEnd: string;
    status: string;
  },
  cycleId: string,
): Promise<void> {
  const banIds = await scopedBanIds(run, cycleId);
  if (banIds.length === 0) {
    throw new Error(
      "billrun-live-kestra-smoke: the run scoped zero accounts — run " +
        "db:seed-sample against this database first.",
    );
  }

  const scopedOrgs = await db
    .selectDistinct({ registrationNumber: organization.registrationNumber })
    .from(billingAccount)
    .innerJoin(
      partyRole,
      eq(billingAccount.refPartyRoleId, partyRole.partyRoleId),
    )
    .innerJoin(
      organization,
      eq(partyRole.engagedParty, organization.organizationId),
    )
    .where(inArray(billingAccount.billingAccountId, banIds));
  const nonSampleOrg = scopedOrgs.find(
    (o) => o.registrationNumber !== SAMPLE_REGISTRATION_NUMBER,
  );
  if (scopedOrgs.length === 0 || nonSampleOrg) {
    throw new Error(
      "billrun-live-kestra-smoke: the run scopes accounts that are NOT the " +
        `seeded "${SAMPLE_REGISTRATION_NUMBER}" _SAMPLE_ customer (found ` +
        `registrationNumber=${nonSampleOrg?.registrationNumber ?? "none"}) — ` +
        "refusing to operate on what looks like real billing data.",
    );
  }

  // The candidate charges this run would (or did) bill: udr_rated rows whose
  // subscriber ref correlates to a scoped account via the SAME
  // `udr_subscriber_ref_id → product_inventory → billing_account_id` path bm27's
  // Collection uses (mirrored from `rated-lines.repository.ts`; the correlation
  // itself lives in the flow SQL — bm16 record-only — so there is no app service
  // to call). Correlated INDEPENDENT of claim status: a seed row is `RATED` with a
  // NULL `billrun_ban_id`, a claimed row flips to `BILL_DRAFT` with it set — so the
  // old `billrun_ban_id IN (…) AND status='RATED'` shape matched NOTHING on the
  // sample seed and left this half of the gate inert. Now every charge that
  // resolves to a scoped account must carry the `_SAMPLE_` markers, or abort.
  const candidateCharges = await db
    .select({
      udrSourceFile: udrRated.udrSourceFile,
      udrRefBatchId: udrRated.udrRefBatchId,
      ratingEngineVersion: udrRated.ratingEngineVersion,
    })
    .from(udrRated)
    .innerJoin(
      productInventory,
      eq(productInventory.productInventoryId, udrRated.udrSubscriberRefId),
    )
    .where(inArray(productInventory.billingAccountId, banIds));
  // Make the charge boundary a POSITIVE assertion, not a vacuous pass: a scoped
  // _SAMPLE_ set with ZERO correlatable charges is anomalous — the ci seed always
  // carries USAGE/BILL_NOTUSED udr_rated rows for its accounts (and posting/reject
  // never removes them), so an empty result means an incomplete seed or a
  // DATABASE_URL that is not the seeded sample database. Refuse before any write
  // rather than reach triggerRun/rejectRun/rerunRun/rerunDistribution having
  // verified no charge at all.
  if (candidateCharges.length === 0) {
    throw new Error(
      "billrun-live-kestra-smoke: no candidate udr_rated charge correlates to " +
        "any scoped account (udr_subscriber_ref_id → product_inventory → " +
        "billing_account_id) — the _SAMPLE_ ci seed always carries usage, so an " +
        "empty result means the seed is incomplete or DATABASE_URL is not the " +
        "seeded sample database. Refusing to operate.",
    );
  }
  const nonSampleCharge = candidateCharges.find(
    (c) =>
      !SAMPLE_MARKER.test(c.udrSourceFile) ||
      !SAMPLE_MARKER.test(c.udrRefBatchId) ||
      !SAMPLE_MARKER.test(c.ratingEngineVersion),
  );
  if (nonSampleCharge) {
    throw new Error(
      "billrun-live-kestra-smoke: a candidate udr_rated charge for a scoped " +
        "account is NOT _SAMPLE_-marked (udrSourceFile/udrRefBatchId/" +
        "ratingEngineVersion) — refusing to operate on what looks like real " +
        "rated usage.",
    );
  }
}

async function resolveDueSampleRun(today: string): Promise<{
  run: {
    billRunId: string;
    periodStart: string;
    periodEnd: string;
    status: string;
  };
  cycleId: string;
}> {
  const [cycle] = await db
    .select({ billCycleId: billCycle.billCycleId })
    .from(billCycle)
    .where(eq(billCycle.name, DEFAULT_BILL_CYCLE_NAME));
  if (!cycle) {
    throw new Error(
      `billrun-live-kestra-smoke: bill cycle "${DEFAULT_BILL_CYCLE_NAME}" ` +
        "not found — run db:seed-accounts and db:seed-sample against this " +
        "database first.",
    );
  }

  const [run] = await db
    .select({
      billRunId: billRun.billRunId,
      periodStart: billRun.periodStart,
      periodEnd: billRun.periodEnd,
      status: billRun.status,
    })
    .from(billRun)
    .where(
      and(
        eq(billRun.refBillCycleId, cycle.billCycleId),
        eq(billRun.status, "SCHEDULED"),
        // Only a DUE run: never trigger a future-dated SCHEDULED run with
        // today's business date — pick the earliest run whose scheduled date
        // has actually arrived.
        lte(billRun.scheduledRunDate, today),
      ),
    )
    .orderBy(billRun.scheduledRunDate)
    .limit(1);
  if (!run) {
    // Distinguish "never seeded" from "a prior smoke run left the single seeded
    // ci period mid-lifecycle". This gate drives ONE run through the whole
    // journey and is NOT resumable — a crashed/interrupted prior run leaves that
    // run in a non-SCHEDULED state, so `resolveDueSampleRun` finds nothing due.
    // Surface that specifically (with the wedged run's id/state) so the operator
    // re-seeds rather than re-running into the same dead end.
    const [leftover] = await db
      .select({
        billRunId: billRun.billRunId,
        status: billRun.status,
        periodStart: billRun.periodStart,
      })
      .from(billRun)
      .where(
        and(
          eq(billRun.refBillCycleId, cycle.billCycleId),
          ne(billRun.status, "SCHEDULED"),
        ),
      )
      .orderBy(desc(billRun.periodStart))
      .limit(1);
    if (leftover) {
      throw new Error(
        `billrun-live-kestra-smoke: no DUE SCHEDULED run for the ` +
          `"${DEFAULT_BILL_CYCLE_NAME}" cycle, but run ${leftover.billRunId} ` +
          `(period ${leftover.periodStart}) is in state ${leftover.status} — a ` +
          "prior smoke run left it mid-lifecycle. This gate drives one run to " +
          "COMPLETED and is not resumable; re-run db:seed-sample to reset the " +
          "sample graph before re-running the smoke.",
      );
    }
    throw new Error(
      `billrun-live-kestra-smoke: no due SCHEDULED run found for the ` +
        `"${DEFAULT_BILL_CYCLE_NAME}" cycle — run db:seed-sample (it seeds ` +
        "the demo period) before this script.",
    );
  }
  return { run, cycleId: cycle.billCycleId };
}

async function getRunOrThrow(runId: string): Promise<{
  billRunId: string;
  refBillCycleId: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  lastProgressAt: Date | null;
  completedAt: Date | null;
}> {
  const run = await billRunRepository.findById(db, runId);
  if (!run) {
    throw new Error(`billrun-live-kestra-smoke: run ${runId} not found.`);
  }
  // `bill_run.last_progress_at`/`completed_at` are `timestamp({ mode: "date" })`,
  // so `findById` (a typed drizzle select, not a raw `db.execute`) already returns
  // `Date | null` — no string coercion needed for `isStalled`'s `getTime()`.
  return {
    billRunId: run.billRunId,
    refBillCycleId: run.refBillCycleId,
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
    status: run.status,
    lastProgressAt: run.lastProgressAt,
    completedAt: run.completedAt,
  };
}

// ── Reconcile-driven poll (bm37-spec §Implementation §3, "Reconcile
// alignment") ───────────────────────────────────────────────────────────────
// Drives `reconcileRun` — the same "Check status" the operator's StallBanner
// runs — until the run reaches an expected status. On a HEALTHY, progressing run
// (`assertHealthy`) every poll must return `mismatch: false` AND leave the run
// NOT `isStalled`: the stall/reconcile gate must never fire while signals are
// still flowing. (The complementary guarantee — a SUCCESS engine state over a
// non-terminal account grain yields `mismatch: true` with no forced status and
// no heartbeat bump, so a REAL wedge still surfaces — is asserted as a targeted
// unit in `tests/services/billing/reconcile-run.service.test.ts`, per the spec's
// "or by a targeted unit assertion".)
async function pollReconcile(
  runId: string,
  actorId: string,
  opts: {
    until: RunStatus[];
    failOn: RunStatus[];
    assertHealthy: boolean;
    label: string;
  },
): Promise<RunStatus> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const reconciled = await reconcileRun(runId, actorId);
    if (!reconciled.ok) {
      throw new Error(
        `billrun-live-kestra-smoke: ${opts.label}: reconcileRun failed ` +
          `(${reconciled.code}).`,
      );
    }
    const { runStatus, engineState, mismatch } = reconciled.value;
    logger.info(`billrun-live-kestra-smoke: ${opts.label} reconciled.`, {
      runStatus,
      engineState,
      mismatch,
    });

    if (opts.assertHealthy) {
      if (mismatch) {
        throw new Error(
          `billrun-live-kestra-smoke: ${opts.label}: reconcileRun surfaced a ` +
            `mismatch (engine ${engineState} vs the account grain) on a run ` +
            "expected to be healthy — a real wedge or a lost signal, not a " +
            "progressing run.",
        );
      }
      // A deliberate second read AFTER reconcileRun: the stall check must see
      // the POST-reconcile heartbeat (reconcileRun bumps `last_progress_at` on
      // the live/RUNNING branches), so reusing reconcileRun's own pre-write read
      // would evaluate `isStalled` against a stale timestamp.
      const runRow = await getRunOrThrow(runId);
      if (
        isStalled(
          {
            status: runRow.status as RunStatus,
            lastProgressAt: runRow.lastProgressAt,
          },
          new Date(),
          billRunStallThresholdMinutes,
        )
      ) {
        throw new Error(
          `billrun-live-kestra-smoke: ${opts.label}: isStalled=true while ` +
            "signals are still flowing — the stall gate must not fire on a " +
            "healthy, progressing run.",
        );
      }
    }

    if (opts.failOn.includes(runStatus)) {
      throw new Error(
        `billrun-live-kestra-smoke: ${opts.label}: run reached unexpected ` +
          `terminal status ${runStatus}.`,
      );
    }
    if (opts.until.includes(runStatus)) {
      return runStatus;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `billrun-live-kestra-smoke: ${opts.label}: timed out after ` +
          `${POLL_TIMEOUT_MS}ms waiting for ${opts.until.join("/")} ` +
          `(last status: ${runStatus}).`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

// Pick a billed (has a trial `customer_bill`), PROCESSED account to reject.
// `exclude` lets the caller steer AWAY from the just-recovered forced-failure
// account so the reject demonstration exercises a DISTINCT account — but it
// falls back to any billed PROCESSED account if the seed exposes only one, so a
// single-billable seed still works.
async function firstBilledBan(
  runId: string,
  exclude: string[] = [],
): Promise<string> {
  const [statuses, bills] = await Promise.all([
    billRunAccountRepository.listStatusesForRun(db, runId),
    db
      .selectDistinct({ ban: customerBill.refBillingAccountId })
      .from(customerBill)
      .where(eq(customerBill.refBillRunId, runId)),
  ]);
  const processed = new Set(
    statuses
      .filter((s) => s.status === "PROCESSED")
      .map((s) => s.billingAccountId),
  );
  const excluded = new Set(exclude);
  const billedBans = bills
    .map((b) => b.ban)
    .filter((ban) => processed.has(ban));
  const billed = billedBans.find((ban) => !excluded.has(ban)) ?? billedBans[0];
  if (!billed) {
    throw new Error(
      "billrun-live-kestra-smoke: no billed, PROCESSED account found to reject " +
        "— expected the _SAMPLE_ ci seed to produce at least one trial bill.",
    );
  }
  return billed;
}

// ── Leg 1: processing-failure settlement (bm37-spec §Implementation §2) ──────
async function legProcessingFailure(handoffFile: string): Promise<void> {
  assertEngineConfigured();
  if (!billRunProcessingForceFail) {
    throw new Error(
      "billrun-live-kestra-smoke: the `proc-fail` leg requires " +
        "BILLRUN_PROCESSING_FORCE_FAIL=true (the orchestrator sets it per leg).",
    );
  }

  const today = getBusinessToday();
  await materializeDueRuns(today);
  const { run, cycleId } = await resolveDueSampleRun(today);
  await assertSampleOnlyScope(run, cycleId);

  const actorId = await getOrCreateAppUser(
    db,
    TRIGGER_ACTOR.name,
    TRIGGER_ACTOR.email,
  );
  const triggered = await triggerRun(run.billRunId, actorId, today);
  if (!triggered.ok) {
    throw new Error(
      `billrun-live-kestra-smoke: triggerRun failed (${triggered.code}).`,
    );
  }
  logger.info(
    "billrun-live-kestra-smoke: triggered against the real billrun engine " +
      "with processing force-fail ON.",
    { billRunId: run.billRunId, banCount: triggered.value.banCount },
  );

  // The forced account settles to PROCESSING_FAILED via bm36's terminal signal;
  // the run recomputes to PROCESSED (decision (a)) well before any stall
  // threshold could elapse — `assertHealthy` proves the stall gate never fires.
  await pollReconcile(run.billRunId, actorId, {
    until: ["PROCESSED"],
    failOn: ["PROCESSING_FAILED", "DISTRIBUTION_FAILED", "COMPLETED"],
    assertHealthy: true,
    label: "processing-failure settlement",
  });

  const statuses = await billRunAccountRepository.listStatusesForRun(
    db,
    run.billRunId,
  );
  const failed = statuses.filter((s) => s.status === "PROCESSING_FAILED");
  const processed = statuses.filter((s) => s.status === "PROCESSED");
  if (failed.length < 1) {
    throw new Error(
      "billrun-live-kestra-smoke: expected at least one forced " +
        "PROCESSING_FAILED account after triggering with force-fail on — none " +
        "found (did BILLRUN_PROCESSING_FORCE_FAIL reach the flow?).",
    );
  }
  if (processed.length < 1) {
    throw new Error(
      "billrun-live-kestra-smoke: expected the non-forced accounts to reach " +
        "PROCESSED (a contained per-account failure, not a whole-run failure).",
    );
  }
  logger.info(
    "billrun-live-kestra-smoke: forced account(s) settled to PROCESSING_FAILED " +
      "via the terminal signal; run recomputed to PROCESSED (bm37 decision (a) " +
      "— the failed account will be SKIPPED at approval).",
    {
      billRunId: run.billRunId,
      failed: failed.map((f) => f.billingAccountId),
      processedCount: processed.length,
    },
  );

  writeFileSync(handoffFile, run.billRunId, "utf8");
}

// ── Leg 2: recover -> reject/block/reprocess -> approve -> post -> forced
// distribution failure (bm37-spec §Implementation §1) ────────────────────────
async function legDrive(runId: string): Promise<void> {
  assertEngineConfigured();
  if (billRunProcessingForceFail) {
    throw new Error(
      "billrun-live-kestra-smoke: the `drive` leg requires " +
        "BILLRUN_PROCESSING_FORCE_FAIL=false so the recovery/reprocess reruns " +
        "settle cleanly.",
    );
  }
  if (!billRunDistributionForceFail) {
    throw new Error(
      "billrun-live-kestra-smoke: the `drive` leg requires " +
        "BILLRUN_DISTRIBUTION_FORCE_FAIL=true so the first distribution attempt " +
        "force-fails (the orchestrator sets it per leg).",
    );
  }

  const run = await getRunOrThrow(runId);
  await assertSampleOnlyScope(run, run.refBillCycleId);

  const triggerActorId = await getOrCreateAppUser(
    db,
    TRIGGER_ACTOR.name,
    TRIGGER_ACTOR.email,
  );
  const approveActorId = await getOrCreateAppUser(
    db,
    APPROVE_ACTOR.name,
    APPROVE_ACTOR.email,
  );

  // 1. Recover the forced-failure account carried over from leg 1.
  const before = await billRunAccountRepository.listStatusesForRun(db, runId);
  const failedBans = before
    .filter((s) => s.status === "PROCESSING_FAILED")
    .map((s) => s.billingAccountId);
  if (failedBans.length === 0) {
    throw new Error(
      "billrun-live-kestra-smoke: no PROCESSING_FAILED account to recover — " +
        "expected the forced failure from the processing-failure leg.",
    );
  }
  const recover = await rerunRun(
    {
      billRunId: runId,
      accountIds: failedBans,
      fromStage: "validation",
      reason: "bm37 smoke: recover the forced processing-failure account.",
    },
    triggerActorId,
  );
  if (!recover.ok) {
    throw new Error(
      `billrun-live-kestra-smoke: rerunRun (recover) failed (${recover.code}).`,
    );
  }
  await pollReconcile(runId, triggerActorId, {
    until: ["PROCESSED"],
    failOn: ["PROCESSING_FAILED", "DISTRIBUTION_FAILED", "COMPLETED"],
    assertHealthy: true,
    label: "forced-failure recovery",
  });
  const afterRecover = await billRunAccountRepository.listStatusesForRun(
    db,
    runId,
  );
  if (afterRecover.some((s) => s.status === "PROCESSING_FAILED")) {
    throw new Error(
      "billrun-live-kestra-smoke: an account is still PROCESSING_FAILED after " +
        "the recovery rerun (force-fail off).",
    );
  }
  logger.info("billrun-live-kestra-smoke: forced-failure account recovered.");

  // 2. Reject a billed account — the run stays PROCESSED (model (b)); the
  // REJECTED_PENDING_REPROCESS marker is set and approval is blocked. Steer away
  // from the just-recovered forced account so the reject exercises a distinct
  // account where the seed exposes more than one billable account.
  const billedBan = await firstBilledBan(runId, failedBans);
  const rejected = await rejectRun(
    {
      billRunId: runId,
      scope: "selected",
      banIds: [billedBan],
      reason: "bm37 smoke: reject demonstration.",
    },
    approveActorId,
  );
  if (!rejected.ok) {
    throw new Error(
      `billrun-live-kestra-smoke: rejectRun failed (${rejected.code}).`,
    );
  }
  const afterReject = await getRunOrThrow(runId);
  if (afterReject.status !== "PROCESSED") {
    throw new Error(
      `billrun-live-kestra-smoke: run left ${afterReject.status} after reject ` +
        "— expected it to stay PROCESSED (reject model (b)).",
    );
  }
  const pending = await billRunAccountStageRepository.listRejectedPendingForRun(
    db,
    runId,
  );
  if (!pending.some((p) => p.billingAccountId === billedBan)) {
    throw new Error(
      "billrun-live-kestra-smoke: REJECTED_PENDING_REPROCESS marker not set on " +
        "the rejected account.",
    );
  }
  const blocked = await approveRun(runId, approveActorId);
  if (blocked.ok) {
    throw new Error(
      "billrun-live-kestra-smoke: approval succeeded while an account was " +
        "pending reprocess — the no_rejected_pending gate did not fire.",
    );
  }
  if (blocked.code !== "CHECKS_FAILED") {
    throw new Error(
      `billrun-live-kestra-smoke: expected CHECKS_FAILED on the blocked ` +
        `approval, got ${blocked.code}.`,
    );
  }
  const noRejectedPending = blocked.checks.find(
    (c) => c.check === "no_rejected_pending",
  );
  if (!noRejectedPending || noRejectedPending.pass) {
    throw new Error(
      "billrun-live-kestra-smoke: the no_rejected_pending pre-approval check " +
        "did not fail as expected while a rejected account was pending.",
    );
  }
  logger.info(
    "billrun-live-kestra-smoke: rejected a billed account; approval blocked by " +
      "no_rejected_pending.",
    { billedBan },
  );

  // 3. Reprocess the rejected account -> PROCESSED, marker cleared.
  const reprocess = await rerunRun(
    {
      billRunId: runId,
      accountIds: [billedBan],
      fromStage: "validation",
      reason: "bm37 smoke: reprocess the rejected account.",
    },
    triggerActorId,
  );
  if (!reprocess.ok) {
    throw new Error(
      `billrun-live-kestra-smoke: rerunRun (reprocess) failed ` +
        `(${reprocess.code}).`,
    );
  }
  await pollReconcile(runId, triggerActorId, {
    until: ["PROCESSED"],
    failOn: ["PROCESSING_FAILED", "DISTRIBUTION_FAILED", "COMPLETED"],
    assertHealthy: true,
    label: "rejected-account reprocess",
  });
  const pendingAfter =
    await billRunAccountStageRepository.listRejectedPendingForRun(db, runId);
  if (pendingAfter.some((p) => p.billingAccountId === billedBan)) {
    throw new Error(
      "billrun-live-kestra-smoke: REJECTED_PENDING_REPROCESS marker still set " +
        "after the reprocess rerun.",
    );
  }

  // 4. Approve — four-eyes, a different actor than the trigger operator.
  const approved = await approveRun(runId, approveActorId);
  if (!approved.ok) {
    throw new Error(
      `billrun-live-kestra-smoke: approveRun failed (${approved.code}).`,
    );
  }
  const approvedRun = await getRunOrThrow(runId);
  if (approvedRun.status !== "APPROVED") {
    throw new Error(
      `billrun-live-kestra-smoke: run ${approvedRun.status} after approve — ` +
        "expected APPROVED.",
    );
  }
  logger.info("billrun-live-kestra-smoke: approved (four-eyes).", {
    skippedCount: approved.value.skippedCount,
  });

  // 5. Post -> INVOICED -> auto distribution (force-fail on) ->
  // DISTRIBUTION_FAILED.
  const posted = await postRun(runId, approveActorId);
  if (!posted.ok) {
    throw new Error(
      `billrun-live-kestra-smoke: postRun failed (${posted.code}).`,
    );
  }
  logger.info(
    "billrun-live-kestra-smoke: posted; distribution auto-launched with " +
      "force-fail ON.",
    { invoicedAccounts: posted.value.results.length },
  );
  // A successful post + auto-distribute must leave the run at DISTRIBUTING:
  // triggerDistribution is awaited before postRun returns (post-commit), and the
  // real engine runs the flow asynchronously. Two failure modes leave the run
  // SHORT of DISTRIBUTING, and neither can ever reach DISTRIBUTION_FAILED — so
  // polling for it would only ride to a 10-minute timeout:
  //   - INVOICED: postRun SWALLOWS a failed triggerDistribution (post-run.ts
  //     logs it, does not throw), so no distribution execution ever started.
  //   - POSTING: an account PARKED at posting (e.g. PERIOD_CLOSED), so postRun
  //     never completed to INVOICED and never auto-triggered distribution
  //     (posted.value.completed is false).
  // Fail fast with the actual status rather than polling into a timeout.
  const afterPost = await getRunOrThrow(runId);
  if (afterPost.status !== "DISTRIBUTING") {
    throw new Error(
      "billrun-live-kestra-smoke: after postRun the run is " +
        `${afterPost.status}, not DISTRIBUTING (completed=${posted.value.completed}). ` +
        "INVOICED means the automatic distribution trigger did not start " +
        "(postRun swallows a failed triggerDistribution — see its logged error " +
        "above); POSTING means an account parked at posting. Neither can reach " +
        "DISTRIBUTION_FAILED — refusing to poll into a timeout. Check the engine " +
        "is reachable / the accounting period is open and re-run.",
    );
  }
  await pollReconcile(runId, approveActorId, {
    until: ["DISTRIBUTION_FAILED"],
    failOn: ["COMPLETED"],
    assertHealthy: true,
    label: "distribution force-fail",
  });
  logger.info(
    "billrun-live-kestra-smoke: distribution force-failed to " +
      "DISTRIBUTION_FAILED as expected.",
  );
}

// ── Leg 3: rerun distribution (force-fail off) -> COMPLETED (bm37-spec
// §Implementation §1 step 5) ─────────────────────────────────────────────────
async function legRedistribute(runId: string): Promise<void> {
  assertEngineConfigured();
  if (billRunDistributionForceFail) {
    throw new Error(
      "billrun-live-kestra-smoke: the `redist` leg requires " +
        "BILLRUN_DISTRIBUTION_FORCE_FAIL=false so the retry can succeed.",
    );
  }

  const run = await getRunOrThrow(runId);
  if (run.status !== "DISTRIBUTION_FAILED") {
    throw new Error(
      `billrun-live-kestra-smoke: expected the run to be DISTRIBUTION_FAILED ` +
        `before the retry, found ${run.status}.`,
    );
  }
  await assertSampleOnlyScope(run, run.refBillCycleId);

  const approveActorId = await getOrCreateAppUser(
    db,
    APPROVE_ACTOR.name,
    APPROVE_ACTOR.email,
  );
  const redist = await rerunDistribution(runId, approveActorId);
  if (!redist.ok) {
    throw new Error(
      `billrun-live-kestra-smoke: rerunDistribution failed (${redist.code}).`,
    );
  }
  logger.info(
    "billrun-live-kestra-smoke: distribution retried with force-fail OFF.",
    {
      attempt: redist.value.attempt,
      artifactCount: redist.value.artifactCount,
    },
  );

  await pollReconcile(runId, approveActorId, {
    until: ["COMPLETED"],
    failOn: ["DISTRIBUTION_FAILED"],
    assertHealthy: true,
    label: "distribution retry",
  });
  const done = await getRunOrThrow(runId);
  if (done.status !== "COMPLETED" || !done.completedAt) {
    throw new Error(
      "billrun-live-kestra-smoke: run did not reach COMPLETED with completedAt " +
        `set (status=${done.status}).`,
    );
  }
  logger.info(
    "billrun-live-kestra-smoke: reached COMPLETED — the full operator journey " +
      "is proven end-to-end against the real engine.",
  );
}

// ── Orchestrator (no SMOKE_LEG) — spawns the three legs in sequence, each in
// its own process with its own force-fail configuration ──────────────────────
function runLeg(leg: SmokeLeg, extraEnv: Record<string, string>): void {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    throw new Error(
      "billrun-live-kestra-smoke: cannot resolve this script's path to spawn " +
        "a leg process.",
    );
  }
  // Re-use the parent's node flags (so children run TS via tsx) EXCEPT
  // `--env-file`: the parent already loaded `.env` into its own process.env, and
  // the children inherit it here — passing overrides via `env` keeps them
  // authoritative over anything `.env` might set. Handle BOTH `--env-file=.env`
  // (one token) and `--env-file .env` (two tokens) so a stray `.env` value never
  // gets spliced ahead of the script path and run as the entry file.
  const parentArgv = process.execArgv;
  const childArgv: string[] = [];
  for (let i = 0; i < parentArgv.length; i++) {
    const arg = parentArgv[i]!;
    if (arg === "--env-file") {
      i++; // skip its value token too
      continue;
    }
    if (arg.startsWith("--env-file=")) continue;
    childArgv.push(arg);
  }
  logger.info(`billrun-live-kestra-smoke: launching leg "${leg}".`, {
    forceFail: {
      processing: extraEnv.BILLRUN_PROCESSING_FORCE_FAIL,
      distribution: extraEnv.BILLRUN_DISTRIBUTION_FORCE_FAIL,
    },
  });
  const result = spawnSync(process.execPath, [...childArgv, scriptPath], {
    stdio: "inherit",
    env: { ...process.env, SMOKE_LEG: leg, ...extraEnv },
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `billrun-live-kestra-smoke: leg "${leg}" exited with ` +
        (result.status !== null
          ? `code ${result.status}`
          : `signal ${result.signal ?? "unknown"}`) +
        ".",
    );
  }
}

async function orchestrate(): Promise<void> {
  // Fail fast before spawning anything if the engine isn't real.
  assertEngineConfigured();

  const handoff = join(tmpdir(), `billrun-smoke-${randomUUID()}.runid`);
  logger.info(
    "billrun-live-kestra-smoke: orchestrating the full SCHEDULED -> COMPLETED " +
      "lifecycle across three sequenced leg processes (force-fail toggles are " +
      "process-global, so each leg runs in its own process).",
  );

  // Leg 1 — processing force-fail settlement; hands off the run id.
  runLeg("proc-fail", {
    BILLRUN_PROCESSING_FORCE_FAIL: "true",
    BILLRUN_DISTRIBUTION_FORCE_FAIL: "false",
    SMOKE_HANDOFF_FILE: handoff,
  });
  if (!existsSync(handoff)) {
    throw new Error(
      "billrun-live-kestra-smoke: the proc-fail leg exited 0 without writing the " +
        "run-id handoff file — it likely returned before triggering. See the " +
        "leg's output above.",
    );
  }
  const runId = readFileSync(handoff, "utf8").trim();
  if (!runId) {
    throw new Error(
      "billrun-live-kestra-smoke: the proc-fail leg did not hand off a run id.",
    );
  }

  // Leg 2 — recover, reject/block/reprocess, approve, post, forced distribution
  // failure (processing force-fail OFF, distribution force-fail ON).
  runLeg("drive", {
    BILLRUN_PROCESSING_FORCE_FAIL: "false",
    BILLRUN_DISTRIBUTION_FORCE_FAIL: "true",
    SMOKE_RUN_ID: runId,
  });

  // Leg 3 — rerun distribution to COMPLETED (all force-fail OFF).
  runLeg("redist", {
    BILLRUN_PROCESSING_FORCE_FAIL: "false",
    BILLRUN_DISTRIBUTION_FORCE_FAIL: "false",
    SMOKE_RUN_ID: runId,
  });

  logger.info(
    "billrun-live-kestra-smoke: FULL SCHEDULED -> COMPLETED lifecycle proven " +
      "on the _SAMPLE_ ci seed against the real billrun engine — processing " +
      "force-fail settlement + recovery, reject -> blocked approval -> " +
      "reprocess, four-eyes approve, post -> INVOICED, distribution force-fail " +
      "-> retry -> COMPLETED, with reconcile/stall integrity held throughout. " +
      "The bm16/bm20 live-Kestra gate is CLOSED for local.",
    { billRunId: runId },
  );
}

function requireRunId(): string {
  const runId = process.env.SMOKE_RUN_ID;
  if (!runId) {
    throw new Error(
      "billrun-live-kestra-smoke: this leg requires SMOKE_RUN_ID (set by the " +
        "orchestrator).",
    );
  }
  return runId;
}

async function main(): Promise<void> {
  const leg = process.env.SMOKE_LEG;
  switch (leg) {
    case undefined:
    case "":
      await orchestrate();
      return;
    case "proc-fail": {
      const handoff = process.env.SMOKE_HANDOFF_FILE;
      if (!handoff) {
        throw new Error(
          "billrun-live-kestra-smoke: the proc-fail leg requires " +
            "SMOKE_HANDOFF_FILE (set by the orchestrator).",
        );
      }
      await legProcessingFailure(handoff);
      return;
    }
    case "drive":
      await legDrive(requireRunId());
      return;
    case "redist":
      await legRedistribute(requireRunId());
      return;
    default:
      throw new Error(`billrun-live-kestra-smoke: unknown SMOKE_LEG "${leg}".`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    logger.error("billrun-live-kestra-smoke: failed.", { err });
    process.exit(1);
  });
