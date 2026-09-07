import { and, desc, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { billingAccount } from "@/db/schema/billing/accounts";
import { billRunAccount } from "@/db/schema/billing/bill-run-account";
import { billRunAccountStage } from "@/db/schema/billing/bill-run-account-stage";
import type {
  BillRunAccountStage,
  BillRunAccountStageInsert,
} from "@/db/schema/billing/bill-run-account-stage";
import { REJECTED_PENDING_REPROCESS } from "@/types/billing";
import type { RejectedPendingRow } from "@/types/billing";

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

  // bm17-spec §Design/§Implementation §2 — locates the account's latest stage
  // row FOR ITS CURRENT ATTEMPT (the reject service passes the account's own
  // `attemptCount`) — the row the `REJECTED_PENDING_REPROCESS` marker is
  // stamped on. Highest `bill_run_account_stage_id` wins (sequence-assigned,
  // monotonic — same tiebreak idiom as `listErrorsForRun`).
  async findLatestForAccount(
    tx: Database,
    billRunId: string,
    billingAccountId: string,
    attempt: number,
  ): Promise<{ billRunAccountStageId: string; periodPartition: string } | null> {
    const [row] = await tx
      .select({
        billRunAccountStageId: billRunAccountStage.billRunAccountStageId,
        periodPartition: billRunAccountStage.periodPartition,
      })
      .from(billRunAccountStage)
      .where(
        and(
          eq(billRunAccountStage.refBillRunId, billRunId),
          eq(billRunAccountStage.refBillingAccountId, billingAccountId),
          eq(billRunAccountStage.attempt, attempt),
        ),
      )
      .orderBy(desc(billRunAccountStage.billRunAccountStageId))
      .limit(1);
    return row ?? null;
  },

  // bm17-spec §Design/§Implementation §2 — stamps the marker on exactly the
  // row `findLatestForAccount` resolved. Never touches `status`/`errorClass`
  // — the row stays whatever terminal state it already recorded; only the
  // diagnostic fields change (same non-clobbering convention as
  // `bill-run-account.repository.ts`'s `updateStatus`).
  async stampMarker(
    tx: Database,
    billRunAccountStageId: string,
    periodPartition: string,
    errorDetail: string,
  ): Promise<void> {
    await tx
      .update(billRunAccountStage)
      .set({ errorCode: REJECTED_PENDING_REPROCESS, errorDetail })
      .where(
        and(
          eq(billRunAccountStage.billRunAccountStageId, billRunAccountStageId),
          eq(billRunAccountStage.periodPartition, periodPartition),
        ),
      );
  },

  // bm17-spec §Design "no_rejected_pending" pre-approval check + the Errors
  // tab's "Rejected — pending reprocess" read. An account carries the marker
  // only on ITS CURRENT ATTEMPT's latest stage row — joining on
  // `stage.attempt = bill_run_account.attempt_count` is what makes a rerun's
  // attempt bump implicitly clear the marker (Phase-2 review fold T6): once
  // the processor re-claims under the new attempt and signals a fresh stage
  // row, the marked row belongs to a superseded attempt and no longer
  // matches this join.
  async listRejectedPendingForRun(
    db: Database,
    billRunId: string,
  ): Promise<RejectedPendingRow[]> {
    return db
      .select({
        billingAccountId: billRunAccountStage.refBillingAccountId,
        accountName: billingAccount.name,
        errorDetail: billRunAccountStage.errorDetail,
      })
      .from(billRunAccountStage)
      .innerJoin(
        billRunAccount,
        and(
          eq(billRunAccountStage.refBillRunId, billRunAccount.refBillRunId),
          eq(
            billRunAccountStage.refBillingAccountId,
            billRunAccount.refBillingAccountId,
          ),
          eq(billRunAccountStage.attempt, billRunAccount.attemptCount),
        ),
      )
      .innerJoin(
        billingAccount,
        eq(
          billRunAccountStage.refBillingAccountId,
          billingAccount.billingAccountId,
        ),
      )
      .where(
        and(
          eq(billRunAccountStage.refBillRunId, billRunId),
          eq(billRunAccountStage.errorCode, REJECTED_PENDING_REPROCESS),
        ),
      )
      .orderBy(billingAccount.name);
  },
};
