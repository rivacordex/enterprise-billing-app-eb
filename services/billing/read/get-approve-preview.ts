import { db } from "@/db/client";
import { auditLogRepository } from "@/db/repositories/audit-log.repository";
import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import { runPreApprovalChecks } from "@/services/billing/pre-approval-checks";
import type { PreApprovalCheck } from "@/services/billing/pre-approval-checks";
import type { RunStatus } from "@/types/billing";

// bm10-spec §Design/§Visual. The Approve & Post page's read model — the run
// header, the final trigger actor (the newest `BILL_RUN_TRIGGERED`/
// `BILL_RUN_RERUN` audit row — a rerun never re-stamps `triggered_by`, bm08
// resolved decision, so this is the same actor the four-eyes check compares
// against), the postable/skipped preview counts, and the live pre-approval
// checks evaluated for the CURRENT viewer (so the self-approval block shows
// correctly even before they click Approve). Derives live, never cached
// (architecture Inv. #12).

export interface ApprovePreview {
  billRunId: string;
  cycleName: string;
  status: RunStatus;
  periodStart: string;
  periodEnd: string;
  triggeredByName: string | null;
  triggeredAt: Date | null;
  postableCount: number;
  skippedCount: number;
  currency: string | null;
  totalAmount: string;
  checks: PreApprovalCheck[];
}

const TRIGGER_EVENT_TYPES: ReadonlySet<string> = new Set([
  "BILL_RUN_TRIGGERED",
  "BILL_RUN_RERUN",
]);

export async function getApprovePreview(
  billRunId: string,
  approverId: string,
): Promise<ApprovePreview | null> {
  const [run, detail] = await Promise.all([
    billRunRepository.findById(db, billRunId),
    billRunRepository.findDetailById(db, billRunId),
  ]);
  if (!run || !detail) return null;

  const [statuses, currencies, totalAmount, checks, auditRows] =
    await Promise.all([
      billRunAccountRepository.listStatusesForRun(db, billRunId),
      customerBillRepository.listPostableCurrencies(db, billRunId),
      customerBillRepository.sumPostableTotalForRun(db, billRunId),
      runPreApprovalChecks(db, run, approverId),
      auditLogRepository.findByTargetId(db, billRunId),
    ]);

  const postableCount = statuses.filter((s) => s.status === "PROCESSED").length;
  const skippedCount = statuses.filter(
    (s) => s.status === "PROCESSING_FAILED" || s.status === "EXCLUDED",
  ).length;

  // `findByTargetId` orders newest-first, so the first matching row IS the
  // final trigger/rerun attempt.
  const lastTrigger = auditRows.find((r) =>
    TRIGGER_EVENT_TYPES.has(r.eventType),
  );

  return {
    billRunId: run.billRunId,
    cycleName: detail.cycleName,
    status: detail.status as RunStatus,
    periodStart: detail.periodStart,
    periodEnd: detail.periodEnd,
    triggeredByName: lastTrigger?.actorUserName ?? null,
    triggeredAt: lastTrigger?.createdDatetime ?? null,
    postableCount,
    skippedCount,
    currency: currencies[0] ?? null,
    totalAmount,
    checks,
  };
}
