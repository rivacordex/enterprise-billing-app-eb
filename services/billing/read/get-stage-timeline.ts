import { db } from "@/db/client";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { billRunAccountStageRepository } from "@/db/repositories/billing/bill-run-account-stage.repository";
import {
  STAGES,
  type AccountStatus,
  type ErrorClass,
  type Stage,
  type StageStatus,
  type StageTimelineRow,
  type StageTimelineSummary,
} from "@/types/billing";

// bm04-spec §Visual/§Implementation §9. The Workflow tab's read: the
// `StageTimeline` grid (one row per scoped account, one cell per `Stage`) and
// the mid-flight summary — both derived from `bill_run_account` /
// `bill_run_account_stage` on every read, never the optional run-level cache
// (architecture Inv. #12). A cell with no signal yet renders `status: null`
// (the neutral PENDING badge), not a synthesized row.

export interface StageTimelineResult {
  rows: StageTimelineRow[];
  summary: StageTimelineSummary;
}

export async function getStageTimeline(
  billRunId: string,
): Promise<StageTimelineResult> {
  const [accounts, stageRows] = await Promise.all([
    billRunAccountRepository.listStatusesForRun(db, billRunId),
    billRunAccountStageRepository.listLatestForRun(db, billRunId),
  ]);

  const cellsByAccount = new Map<
    string,
    Map<Stage, { status: StageStatus; errorClass: ErrorClass | null }>
  >();
  for (const stageRow of stageRows) {
    let byStage = cellsByAccount.get(stageRow.refBillingAccountId);
    if (!byStage) {
      byStage = new Map();
      cellsByAccount.set(stageRow.refBillingAccountId, byStage);
    }
    byStage.set(stageRow.stage as Stage, {
      status: stageRow.status as StageStatus,
      errorClass: stageRow.errorClass as ErrorClass | null,
    });
  }

  const rows: StageTimelineRow[] = accounts.map((account) => {
    const byStage = cellsByAccount.get(account.billingAccountId);
    return {
      billingAccountId: account.billingAccountId,
      accountStatus: account.status,
      cells: STAGES.map((stage) => {
        const cell = byStage?.get(stage);
        return {
          stage,
          status: cell?.status ?? null,
          errorClass: cell?.errorClass ?? null,
        };
      }),
    };
  });

  const summary = deriveSummary(accounts.map((a) => a.status));

  return { rows, summary };
}

function deriveSummary(
  statuses: readonly AccountStatus[],
): StageTimelineSummary {
  return {
    total: statuses.length,
    processed: statuses.filter((s) => s === "PROCESSED").length,
    processingFailed: statuses.filter((s) => s === "PROCESSING_FAILED").length,
    excluded: statuses.filter((s) => s === "EXCLUDED").length,
  };
}
