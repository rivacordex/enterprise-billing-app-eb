import { desc, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { billRunAccountStage } from "@/db/schema/billing/bill-run-account-stage";
import type {
  BillRunAccountStage,
  BillRunAccountStageInsert,
} from "@/db/schema/billing/bill-run-account-stage";

// bm04-spec §Design/§Implementation §8. `insertStageRow` is the idempotency
// write — the caller (`handleStageSignal`) wraps this in a try/catch and
// treats a caught `bill_run_account_stage_run_ban_stage_attempt_period_unique`
// violation as a 200 no-op replay (Inv. #5); this repository never
// pre-checks for existence.
export const billRunAccountStageRepository = {
  async insertStageRow(
    tx: Database,
    row: BillRunAccountStageInsert,
  ): Promise<BillRunAccountStage> {
    const [inserted] = await tx
      .insert(billRunAccountStage)
      .values(row)
      .returning();
    if (!inserted) {
      throw new Error("bill_run_account_stage insert returned no row");
    }
    return inserted;
  },

  // bm04-spec §Visual — the Workflow tab's `StageTimeline`: the latest
  // attempt per (account, stage) for the run, one row per signal received.
  // `DISTINCT ON` + `ORDER BY ... attempt DESC` picks the highest attempt
  // Postgres-side (never re-derived in JS).
  async listLatestForRun(
    tx: Database,
    billRunId: string,
  ): Promise<BillRunAccountStage[]> {
    return tx
      .selectDistinctOn(
        [billRunAccountStage.refBillingAccountId, billRunAccountStage.stage],
        {
          billRunAccountStageId: billRunAccountStage.billRunAccountStageId,
          refBillRunId: billRunAccountStage.refBillRunId,
          refBillingAccountId: billRunAccountStage.refBillingAccountId,
          periodPartition: billRunAccountStage.periodPartition,
          stage: billRunAccountStage.stage,
          attempt: billRunAccountStage.attempt,
          status: billRunAccountStage.status,
          startedAt: billRunAccountStage.startedAt,
          endedAt: billRunAccountStage.endedAt,
          errorClass: billRunAccountStage.errorClass,
          errorCode: billRunAccountStage.errorCode,
          errorDetail: billRunAccountStage.errorDetail,
        },
      )
      .from(billRunAccountStage)
      .where(eq(billRunAccountStage.refBillRunId, billRunId))
      .orderBy(
        billRunAccountStage.refBillingAccountId,
        billRunAccountStage.stage,
        desc(billRunAccountStage.attempt),
      );
  },
};
