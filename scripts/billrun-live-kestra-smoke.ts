import { and, eq, inArray, lte } from "drizzle-orm";

import { db } from "@/db/client";
import { billCycle } from "@/db/schema/billing/catalogs";
import { billRun } from "@/db/schema/billing/bill-run";
import { billingAccount } from "@/db/schema/billing/accounts";
import { organization, partyRole } from "@/db/schema/customer";
import { udrRated } from "@/db/schema/rating/udr-rated";
import { DEFAULT_BILL_CYCLE_NAME } from "@/db/seeds/accounts/seed-bill-cycles";
import { getOrCreateAppUser } from "@/db/seeds/sample/get-or-create-appuser";
import { config, isBillRunEngineConfigured } from "@/lib/config";
import { logger } from "@/lib/logger";
import { materializeDueRuns } from "@/services/billing/materialize-runs";
import { scopeAccounts } from "@/services/billing/scope-accounts";
import { triggerRun } from "@/services/billing/trigger-run";
import { reconcileRun } from "@/services/billing/reconcile-run";
import { getBusinessToday } from "@/services/billing/business-today";

// bm21-spec §Implementation §1 D-9/§Phase-2 review fold T3 — the live-Kestra
// smoke gate `workflow-management/flows/bill-run-processor/README.md` registers as an explicit phase-2 exit
// criterion. NOT part of the DB-gated CI suite (which doubles the flow — see
// `tests/db/billing-e2e-happy-path.integration.test.ts`'s header): this is a
// deliberately separate, off-by-default script (wired to the
// `billrun_live_kestra_smoke` Azure Pipelines stage,
// `runBillrunLiveKestraSmoke` param, default false) that proves the trigger →
// claim → PROCESSED path against a REALLY DEPLOYED `bill_run_processing` flow
// on a real `billrun` Kestra engine — the one thing the CI-doubled E2E can
// never prove. Refuses to "pass" against the stub engine client (fails loud,
// not a silent skip) so a misconfigured run can never be mistaken for a met
// exit criterion.
//
// Prerequisite: `db:seed-sample` has already seeded the `_SAMPLE_*` scenario
// (against the `DEFAULT_BILL_CYCLE_NAME` cycle) in the target database, and
// `BILLRUN_ENGINE_URL`/`BILLRUN_ENGINE_AUTH`/`BILLRUN_ENGINE_NAMESPACE`
// (`lib/config.ts`) point at that real, deployed namespace — per
// `workflow-management/flows/bill-run-processor/README.md`'s "Repo / Owner / Deploy step" exit criterion.

const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 10 * 60_000;

// The seeded `_SAMPLE_` customer's registration number (db:seed-sample's
// SAMPLE_REGISTRATION_NUMBER) and the provenance-marker prefix its udr_rated
// factory stamps (udr-rated-sample.ts / tests/guardrails/
// billing-sample-seed-marker.test.ts). Redeclared here rather than imported:
// db/seeds/sample/seed-billrun-sample.ts runs its own `main()` on import.
const SAMPLE_REGISTRATION_NUMBER = "_SAMPLE_-BILLRUN-0001";
const SAMPLE_MARKER = /^_SAMPLE_/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  if (!isBillRunEngineConfigured) {
    throw new Error(
      "billrun-live-kestra-smoke: BILLRUN_ENGINE_URL/BILLRUN_ENGINE_AUTH " +
        "are not set to a real engine — this smoke gate refuses to run " +
        "against the STUB client (that would prove nothing about a real " +
        "deployed flow). Configure a real `billrun` Kestra namespace first " +
        "(workflow-management/flows/bill-run-processor/README.md's Repo/Owner/Deploy-step exit criterion).",
    );
  }

  const today = getBusinessToday();
  await materializeDueRuns(today);

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
    throw new Error(
      `billrun-live-kestra-smoke: no due SCHEDULED run found for the ` +
        `"${DEFAULT_BILL_CYCLE_NAME}" cycle — run db:seed-sample (it seeds ` +
        "the demo period) before this script.",
    );
  }

  // Safety gate (bm21-spec §Implementation §1, code-standards §9 item 16) —
  // this script triggers a REAL bill run against whatever DATABASE_URL points
  // at, an irreversible mutation of that database. Before triggerRun, prove the
  // run can only ever touch the unmistakably-fake `_SAMPLE_` seed graph (bm15):
  //   1. the engine must be in placeholder mode,
  //   2. every account the run would scope must belong to the seeded
  //      `_SAMPLE_-BILLRUN-0001` customer, and
  //   3. every candidate `udr_rated` charge must carry the `_SAMPLE_`
  //      provenance markers.
  // Any deviation means DATABASE_URL is pointed at real billing data — abort
  // loudly without triggering, never process it.
  if (!config.BILLRUN_PLACEHOLDER_MODE) {
    throw new Error(
      "billrun-live-kestra-smoke: BILLRUN_PLACEHOLDER_MODE is not set — this " +
        "smoke gate only ever drives the _SAMPLE_ placeholder scenario and " +
        "refuses to trigger a bill run against a non-placeholder engine.",
    );
  }

  const { pending, excluded } = await scopeAccounts(db, {
    billRunId: run.billRunId,
    refBillCycleId: cycle.billCycleId,
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
  });
  const scopedBanIds = [...pending, ...excluded].map(
    (r) => r.refBillingAccountId,
  );
  if (scopedBanIds.length === 0) {
    throw new Error(
      "billrun-live-kestra-smoke: the due SCHEDULED run scoped zero accounts " +
        "— run db:seed-sample against this database first.",
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
    .where(inArray(billingAccount.billingAccountId, scopedBanIds));
  const nonSampleOrg = scopedOrgs.find(
    (o) => o.registrationNumber !== SAMPLE_REGISTRATION_NUMBER,
  );
  if (scopedOrgs.length === 0 || nonSampleOrg) {
    throw new Error(
      "billrun-live-kestra-smoke: the due SCHEDULED run scopes accounts that " +
        `are NOT the seeded "${SAMPLE_REGISTRATION_NUMBER}" _SAMPLE_ customer ` +
        `(found registrationNumber=${nonSampleOrg?.registrationNumber ?? "none"}` +
        ") — refusing to trigger against what looks like real billing data.",
    );
  }

  const candidateCharges = await db
    .select({
      udrSourceFile: udrRated.udrSourceFile,
      udrRefBatchId: udrRated.udrRefBatchId,
      ratingEngineVersion: udrRated.ratingEngineVersion,
    })
    .from(udrRated)
    .where(
      and(
        inArray(udrRated.billrunBanId, scopedBanIds),
        eq(udrRated.status, "RATED"),
      ),
    );
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
        "ratingEngineVersion) — refusing to trigger against what looks like " +
        "real rated usage.",
    );
  }

  const actorId = await getOrCreateAppUser(
    db,
    "billrun-live-kestra-smoke",
    "billrun-live-kestra-smoke@example.invalid",
  );

  const triggered = await triggerRun(run.billRunId, actorId, today);
  if (!triggered.ok) {
    throw new Error(
      `billrun-live-kestra-smoke: triggerRun failed (${triggered.code}).`,
    );
  }
  logger.info(
    "billrun-live-kestra-smoke: triggered against the real billrun engine.",
    {
      billRunId: run.billRunId,
      banCount: triggered.value.banCount,
    },
  );

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const reconciled = await reconcileRun(run.billRunId, actorId);
    if (!reconciled.ok) {
      throw new Error(
        `billrun-live-kestra-smoke: reconcileRun failed (${reconciled.code}).`,
      );
    }
    logger.info("billrun-live-kestra-smoke: reconciled.", reconciled.value);

    if (reconciled.value.runStatus === "PROCESSED") {
      logger.info(
        "billrun-live-kestra-smoke: reached PROCESSED against the real " +
          "billrun engine — trigger -> claim -> PROCESSED proven end-to-end.",
      );
      return;
    }
    if (reconciled.value.runStatus === "PROCESSING_FAILED") {
      throw new Error(
        "billrun-live-kestra-smoke: run reached PROCESSING_FAILED — the " +
          "real engine reported a failure.",
      );
    }
    if (Date.now() > deadline) {
      throw new Error(
        `billrun-live-kestra-smoke: timed out after ${POLL_TIMEOUT_MS}ms ` +
          `waiting for PROCESSED (last status: ${reconciled.value.runStatus}).`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    logger.error("billrun-live-kestra-smoke: failed.", { err });
    process.exit(1);
  });
