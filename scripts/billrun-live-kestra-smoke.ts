import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { billCycle } from "@/db/schema/billing/catalogs";
import { billRun } from "@/db/schema/billing/bill-run";
import { DEFAULT_BILL_CYCLE_NAME } from "@/db/seeds/accounts/seed-bill-cycles";
import { getOrCreateAppUser } from "@/db/seeds/sample/get-or-create-appuser";
import { isBillRunEngineConfigured } from "@/lib/config";
import { logger } from "@/lib/logger";
import { materializeDueRuns } from "@/services/billing/materialize-runs";
import { triggerRun } from "@/services/billing/trigger-run";
import { reconcileRun } from "@/services/billing/reconcile-run";
import { getBusinessToday } from "@/services/billing/business-today";

// bm21-spec §Implementation §1 D-9/§Phase-2 review fold T3 — the live-Kestra
// smoke gate `flows/billrun/README.md` registers as an explicit phase-2 exit
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
// `flows/billrun/README.md`'s "Repo / Owner / Deploy step" exit criterion.

const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 10 * 60_000;

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
        "(flows/billrun/README.md's Repo/Owner/Deploy-step exit criterion).",
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
    .select({ billRunId: billRun.billRunId })
    .from(billRun)
    .where(
      and(
        eq(billRun.refBillCycleId, cycle.billCycleId),
        eq(billRun.status, "SCHEDULED"),
      ),
    )
    .orderBy(billRun.scheduledRunDate)
    .limit(1);
  if (!run) {
    throw new Error(
      `billrun-live-kestra-smoke: no SCHEDULED run found for the ` +
        `"${DEFAULT_BILL_CYCLE_NAME}" cycle — run db:seed-sample (it seeds ` +
        "the demo period) before this script.",
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
  logger.info("billrun-live-kestra-smoke: triggered against the real billrun engine.", {
    billRunId: run.billRunId,
    banCount: triggered.value.banCount,
  });

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
