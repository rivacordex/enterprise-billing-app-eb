import { db } from "@/db/client";
import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import type { RunDetail, RunStatus } from "@/types/billing";

// bm04-spec §Implementation §9. The run-detail page's header read — a plain
// join, no status recompute (code-standards §3.1). `null` means the page
// renders `notFound()`.
export async function getRunDetail(
  billRunId: string,
): Promise<RunDetail | null> {
  const row = await billRunRepository.findDetailById(db, billRunId);
  if (!row) return null;

  return {
    billRunId: row.billRunId,
    cycleName: row.cycleName,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    scheduledRunDate: row.scheduledRunDate,
    status: row.status as RunStatus,
    lastProgressAt: row.lastProgressAt,
  };
}
