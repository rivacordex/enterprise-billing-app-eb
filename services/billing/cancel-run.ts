import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { logger } from "@/lib/logger";
import { getEngineClient } from "@/services/billing/engine-client";

// bm12-spec §Design/§Implementation §3. The cancel transaction — the Layer-3
// escape hatch for a wedged execution (architecture §Design "Layer-3
// escape"): only a `PROCESSING`/`STALLED`-derived run can be cancelled. One
// `db.transaction`:
//   1. `SELECT … FOR UPDATE` the run → guard `status = 'PROCESSING'`.
//   2. `killExecution` — BEST-EFFORT: a failed kill is logged but still lets
//      cancel proceed (the run row, not the engine's execution state, is the
//      source of truth for operability).
//   3. Reset every non-`EXCLUDED` scoped account back to `PENDING`.
//   4. Flip the run `CANCELLED`, clearing the execution reference.
//   5. `insertAuditEvent(BILL_RUN_CANCELLED)`.
// Consumes no invoice numbers (nothing posted this early in the lifecycle);
// the run stays on its `(cycle, period_start)` row and is re-triggerable
// (bm03's trigger guard extended to `CANCELLED`, `trigger-run.ts`).

export type CancelRunResult =
  | { ok: true; value: { billRunId: string; accountsReset: number } }
  | { ok: false; code: "NOT_CANCELLABLE" };

export async function cancelRun(
  billRunId: string,
  actorId: string,
): Promise<CancelRunResult> {
  return db.transaction(async (tx) => {
    const run = await billRunRepository.findByIdForUpdate(tx, billRunId);
    if (!run || run.status !== "PROCESSING") {
      return { ok: false, code: "NOT_CANCELLABLE" } as const;
    }

    if (run.workflowExecutionId) {
      try {
        await getEngineClient().killExecution(run.workflowExecutionId);
      } catch (err) {
        logger.warn(
          "bill-run cancel: killExecution failed, proceeding with cancel",
          {
            billRunId,
            executionId: run.workflowExecutionId,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }

    const accountsReset = await billRunAccountRepository.resetForCancel(
      tx,
      billRunId,
    );
    await billRunRepository.cancel(tx, billRunId);

    await insertAuditEvent(tx, {
      eventType: "BILL_RUN_CANCELLED",
      actorUserId: actorId,
      targetEntity: "BILL_RUN",
      targetId: billRunId,
      beforeData: {
        status: run.status,
        workflowExecutionId: run.workflowExecutionId,
      },
      afterData: { status: "CANCELLED", accountsReset },
    });

    return { ok: true, value: { billRunId, accountsReset } } as const;
  });
}
