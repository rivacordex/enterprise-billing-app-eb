import { db } from "@/db/client";
import { billCycleRepository } from "@/db/repositories/accounts/bill-cycle.repository";
import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import type { MaterializeRunInput } from "@/db/repositories/billing/bill-run.repository";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { logger } from "@/lib/logger";
import { getBusinessToday } from "@/services/billing/business-today";
import { currentDuePeriod } from "@/services/billing/derive-periods";

// bm02-spec §4/§5 (Design §Structural). Lazy materialization: on the list
// page's server render (an RSC write, NOT an action/route/job — architecture
// Inv. #10), compute the single most-recent due period per active MONTHLY
// cycle and insert any missing run, idempotently, in ONE transaction. A
// `BILL_RUN_MATERIALIZED` audit row is written ONLY for a row actually
// inserted — a no-op load writes nothing (code-standards §1.10). No
// multi-month backfill; non-monthly cycles are skipped with a logged note
// (multi-frequency is out of scope, overview §Out of scope).
//
// The write is triggered by a page view but is a system-level lazy creation,
// so its audit rows carry no actor (`actorUserId: null`), like other infra
// writes. Concurrency-safe purely via the `(ref_bill_cycle_id, period_start)`
// UNIQUE + ON CONFLICT DO NOTHING (Inv. #10). `today` is the business day
// resolved once by the caller (defaults to a fresh resolution for standalone
// callers) so a single render's materialize + list agree on the day.
export async function materializeDueRuns(
  today: string = getBusinessToday(),
): Promise<void> {
  const cycles = await billCycleRepository.findAllActive(db);

  const rows: MaterializeRunInput[] = [];
  const cycleNameById = new Map<string, string>();

  for (const cycle of cycles) {
    if (cycle.frequency !== "monthly") {
      // Multi-frequency materialization is out of scope (overview §Out of
      // scope) — skip, don't guess a window.
      logger.info("bill-run materialize: skipping non-monthly cycle", {
        billCycleId: cycle.billCycleId,
        frequency: cycle.frequency,
      });
      continue;
    }

    const due = currentDuePeriod(cycle.cycleDay, today);
    if (due === null) continue; // this month's run date not yet arrived

    cycleNameById.set(cycle.billCycleId, cycle.name);
    rows.push({
      refBillCycleId: cycle.billCycleId,
      periodStart: due.periodStart,
      periodEnd: due.periodEnd,
      scheduledRunDate: due.scheduledRunDate,
    });
  }

  if (rows.length === 0) return;

  await db.transaction(async (tx) => {
    const inserted = await billRunRepository.insertMissingRuns(tx, rows);
    for (const run of inserted) {
      await insertAuditEvent(tx, {
        eventType: "BILL_RUN_MATERIALIZED",
        actorUserId: null,
        targetEntity: "bill_run",
        targetId: run.billRunId,
        beforeData: null,
        afterData: {
          refBillCycleId: run.refBillCycleId,
          cycleName: cycleNameById.get(run.refBillCycleId) ?? null,
          periodStart: run.periodStart,
          periodEnd: run.periodEnd,
          scheduledRunDate: run.scheduledRunDate,
          status: "SCHEDULED",
        },
      });
    }
  });
}
