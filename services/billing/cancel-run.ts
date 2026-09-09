import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { udrStatusRepository } from "@/db/repositories/billing/udr-status.repository";
import { logger } from "@/lib/logger";
import { engineRegistry } from "@/services/billing/engine-registry";

// bm12-spec §Design/§Implementation §3. The cancel transaction — the Layer-3
// escape hatch for a wedged execution (architecture §Design "Layer-3
// escape"): only a `PROCESSING`/`STALLED`-derived run can be cancelled.
//
// bm20-spec §Phase-2 review fold T2 resolved decision: this stays
// `PROCESSING`-only, deliberately NOT extended to a wedged `DISTRIBUTING`
// execution. Cancel's semantics (`resetForCancel` → every scoped account back
// to `PENDING`, release the `rating` claim) are specific to a PRE-approval
// run with nothing posted (Inv. #4/#7) — a `DISTRIBUTING` run has already
// posted every INV, so there is nothing to "reset to PENDING" and no invoice
// number to protect from re-consumption. A wedged `DISTRIBUTING` execution's
// recovery path is "Check status" (`reconcile-run.ts`, extended to this
// status) plus, once genuinely `DISTRIBUTION_FAILED`, either "Rerun
// distribution" or the T11 force-complete/abandon action — never a
// `bill_run`-level cancel. One
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

    if (run.processingExecutionId) {
      try {
        await engineRegistry.killExecution(
          "billrun",
          run.processingExecutionId,
          run.processingEngineRef,
        );
      } catch (err) {
        logger.warn(
          "bill-run cancel: killExecution failed, proceeding with cancel",
          {
            billRunId,
            executionId: run.processingExecutionId,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }

    const accountsReset = await billRunAccountRepository.resetForCancel(
      tx,
      billRunId,
    );
    // bm17-spec §Implementation §4 — release the run's claimed rows back to
    // RATED (abort, D11), distinct from reject's REJECTED. The
    // `status = 'BILL_DRAFT'` predicate means this never touches a
    // `BILL_APPROVED`/posted row.
    await udrStatusRepository.release(tx, billRunId);
    await billRunRepository.cancel(tx, billRunId);

    await insertAuditEvent(tx, {
      eventType: "BILL_RUN_CANCELLED",
      actorUserId: actorId,
      targetEntity: "BILL_RUN",
      targetId: billRunId,
      beforeData: {
        status: run.status,
        processingExecutionId: run.processingExecutionId,
      },
      afterData: { status: "CANCELLED", accountsReset },
    });

    return { ok: true, value: { billRunId, accountsReset } } as const;
  });
}
