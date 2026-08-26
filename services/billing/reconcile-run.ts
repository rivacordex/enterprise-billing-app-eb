import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import {
  computeRunCounters,
  computeRunStatus,
} from "@/services/billing/compute-run-status";
import { getEngineClient } from "@/services/billing/engine-client";
import type { ExecutionState } from "@/services/billing/engine-client";
import type { RunStatus } from "@/types/billing";

// bm12-spec §Design/§Implementation §3. "Check status" — reconciles the run
// against the workflow engine's ground truth. Read-only to the ledger; no
// invoice numbers touched. One `db.transaction`, row-locked (Inv. #12 — the
// run status is only ever recomputed under `FOR UPDATE`, never guessed):
//   - Engine RUNNING → alive; just bump the heartbeat (resets the stall
//     clock — a slow-but-live execution shouldn't keep re-flagging STALLED
//     the instant an operator checks it).
//   - Engine FAILED/KILLED → the app was never told (a lost status push);
//     push the run to the rerunnable `PROCESSING_FAILED` terminal state.
//   - Engine SUCCESS → the app's own account-grain truth
//     (`bill_run_account`) is re-derived via the same pure `computeRunStatus`
//     every stage signal uses; if every account is now terminal, the run
//     flips to `PROCESSED` (a lost final stage signal is repaired). If not,
//     the engine's opinion and the app's are in genuine disagreement — that
//     mismatch is surfaced to the operator rather than forcing a status the
//     account grain doesn't support.
//   - Any other current run status (already resolved by another path) → just
//     bump the heartbeat.

export type ReconcileRunResult =
  | {
      ok: true;
      value: {
        billRunId: string;
        runStatus: RunStatus;
        engineState: ExecutionState;
        mismatch: boolean;
      };
    }
  | { ok: false; code: "NOT_FOUND" }
  | { ok: false; code: "NO_EXECUTION" }
  | { ok: false; code: "ENGINE_UNREACHABLE" };

export async function reconcileRun(
  billRunId: string,
  actorId: string,
): Promise<ReconcileRunResult> {
  return db.transaction(async (tx) => {
    const run = await billRunRepository.findByIdForUpdate(tx, billRunId);
    if (!run) return { ok: false, code: "NOT_FOUND" } as const;
    if (!run.workflowExecutionId) {
      return { ok: false, code: "NO_EXECUTION" } as const;
    }

    let execStatus;
    try {
      execStatus = await getEngineClient().getExecutionStatus(
        run.workflowExecutionId,
      );
    } catch {
      return { ok: false, code: "ENGINE_UNREACHABLE" } as const;
    }

    let runStatus = run.status as RunStatus;
    let mismatch = false;

    if (run.status === "PROCESSING") {
      if (execStatus.state === "FAILED" || execStatus.state === "KILLED") {
        await billRunRepository.markProcessingFailed(tx, billRunId);
        runStatus = "PROCESSING_FAILED";
      } else if (execStatus.state === "SUCCESS") {
        const statuses = await billRunAccountRepository.listStatusesForRun(
          tx,
          billRunId,
        );
        const accountStatuses = statuses.map((s) => s.status);
        const computed = computeRunStatus(accountStatuses);
        if (computed) {
          await billRunRepository.recomputeStatus(tx, billRunId, {
            newStatus: computed,
            ...computeRunCounters(accountStatuses),
          });
          runStatus = computed;
        } else {
          // Engine says SUCCESS but the account grain disagrees (a lost signal
          // left an account non-terminal) — a genuine, unresolved wedge. Do NOT
          // bump the heartbeat here: unlike the RUNNING/alive branch below,
          // there is no live execution to justify resetting the stall clock, and
          // bumping it would flip `isStalled` false on the operator's very next
          // refresh — unmounting the StallBanner (the sole host of Check status /
          // Cancel run) for another full threshold window on a run that is
          // actually stuck. Leave the run flagged so the operator can act.
          mismatch = true;
        }
      } else {
        await billRunRepository.bumpHeartbeat(tx, billRunId);
      }
    } else {
      await billRunRepository.bumpHeartbeat(tx, billRunId);
    }

    await insertAuditEvent(tx, {
      eventType: "BILL_RUN_RECONCILED",
      actorUserId: actorId,
      targetEntity: "BILL_RUN",
      targetId: billRunId,
      beforeData: { status: run.status },
      afterData: {
        status: runStatus,
        engineState: execStatus.state,
        mismatch,
      },
    });

    return {
      ok: true,
      value: { billRunId, runStatus, engineState: execStatus.state, mismatch },
    } as const;
  });
}
