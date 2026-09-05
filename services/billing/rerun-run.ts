import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import { computeRunCounters } from "@/services/billing/compute-run-status";
import { engineRegistry } from "@/services/billing/engine-registry";
import type { AccountStatus } from "@/types/billing";
import type { RerunStage } from "@/validation/billing/rerun-run.schema";

// bm08-spec §Design/§Implementation §1, revised bm16-spec §Design "Fork B —
// Phase-1 app-side compute retired". The rerun transaction — pre-approval
// only. In one `db.transaction`, in this order:
//   1. AUDIT FIRST — write the `BILL_RUN_RERUN` row (prior totals + reason)
//      BEFORE any re-trigger (architecture Inv.; code-standards §1.10).
//   2. `attempt_count += 1` for the selected accounts; drop them to PROCESSING.
//   3. Invalidate later stages — implicit: `bill_run_account_stage` is keyed by
//      `attempt`, so the bumped attempt makes every new signal from the chosen
//      stage onward land on a fresh row; prior-attempt rows stay as history.
//   4. Claim release/re-claim — the processor's concern (T6, bm16-spec review
//      folds): the re-triggered `bill_run_processing` execution is the SOLE
//      re-claimer, re-claiming `RATED`/`REJECTED` → `BILL_DRAFT` and
//      re-stamping `billrun_attempt` to the new attempt itself — this service
//      no longer re-derives a trial bill inline (bm08's `aggregateBill`/
//      `taxBill` delta-refresh is retired: phase 2 moves that write into the
//      processor, as `billrun_runtime` — a second app-side writer would
//      violate the two-writer boundary, architecture Inv. #2).
//   5. Re-trigger the engine scoped to the rerun accounts + new attempt.
// The engine call is inside the txn (bm03 pattern): a failure rolls the whole
// rerun back — the audit row and the attempt bump both vanish, and the run
// stays as it was.

export type RerunRunResult =
  | {
      ok: true;
      value: {
        billRunId: string;
        accountCount: number;
        fromStage: RerunStage;
        attempt: number;
        priorTotals: string;
        executionId: string;
      };
    }
  | { ok: false; code: "NOT_RERUNNABLE" }
  | { ok: false; code: "NO_ACCOUNTS_SELECTED" }
  | { ok: false; code: "ENGINE_UNREACHABLE" };

export interface RerunRunParams {
  billRunId: string;
  accountIds: string[];
  fromStage: RerunStage;
  reason: string;
}

// A run is rerunnable only while pre-approval: PROCESSED (the normal path) or
// PROCESSING_FAILED (recover a failed run). APPROVED+ is rejected (Inv. #4 —
// finalized state), as are SCHEDULED (never triggered) and mid-flight
// PROCESSING.
const RERUNNABLE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "PROCESSED",
  "PROCESSING_FAILED",
]);

// Internal-only signal thrown from inside `db.transaction` so an engine failure
// rolls the whole rerun back (throwing is drizzle's rollback trigger) while the
// outer call still returns a typed result instead of rejecting (bm03 pattern).
class EngineUnreachableSignal extends Error {}

export async function rerunRun(
  params: RerunRunParams,
  actorId: string,
): Promise<RerunRunResult> {
  try {
    return await db.transaction(async (tx) => {
      const run = await billRunRepository.findByIdForUpdate(
        tx,
        params.billRunId,
      );
      if (!run || !RERUNNABLE_RUN_STATUSES.has(run.status)) {
        return { ok: false, code: "NOT_RERUNNABLE" } as const;
      }

      // Resolve the eligible rerun set: every scoped account, minus the
      // deliberately-not-billed (`EXCLUDED`) and the finalized (posted bill,
      // Inv. #4), intersected with the caller's selection (empty ⇒ all). The
      // two reads are both keyed only on the run and independent — issue them
      // together. `accounts` (all accounts, incl. `EXCLUDED`) also feeds the
      // in-memory counter recompute below, so no second status read is needed.
      const [accounts, postedIds] = await Promise.all([
        billRunAccountRepository.listForRerun(tx, run.billRunId),
        customerBillRepository.listPostedAccountIds(tx, run.billRunId),
      ]);
      const posted = new Set(postedIds);
      const requested = new Set(params.accountIds);
      const eligible = accounts.filter(
        (a) =>
          a.status !== "EXCLUDED" &&
          !posted.has(a.billingAccountId) &&
          (requested.size === 0 || requested.has(a.billingAccountId)),
      );
      if (eligible.length === 0) {
        return { ok: false, code: "NO_ACCOUNTS_SELECTED" } as const;
      }

      const banIds = eligible.map((a) => a.billingAccountId);
      const newAttempt = Math.max(...eligible.map((a) => a.attemptCount)) + 1;
      const priorTotals = await customerBillRepository.sumTotalsForAccounts(
        tx,
        run.billRunId,
        banIds,
      );

      // 1. AUDIT FIRST — committed before the engine is re-triggered.
      await insertAuditEvent(tx, {
        eventType: "BILL_RUN_RERUN",
        actorUserId: actorId,
        targetEntity: "BILL_RUN",
        targetId: run.billRunId,
        beforeData: { priorTotals },
        afterData: {
          accounts: banIds,
          fromStage: params.fromStage,
          attempt: newAttempt,
          reason: params.reason,
        },
      });

      // 2 + 3. Set every selected account to the uniform new attempt
      // (invalidating later stages via the attempt-keyed latch) and drop them
      // back to PROCESSING — one attempt matching the audited/engine value.
      await billRunAccountRepository.setAttemptForRerun(
        tx,
        run.billRunId,
        banIds,
        newAttempt,
      );

      // 4. Claim release/re-claim + trial-bill re-derivation are the
      // re-triggered processor's concern now (bm16-spec Fork B / T6) — the
      // re-triggered execution re-claims RATED/REJECTED → BILL_DRAFT under the
      // new attempt and re-aggregates/re-taxes as it re-validates each account
      // through the single `handle-stage-signal` path. Nothing to do here.

      // 5. Re-trigger the engine scoped to the rerun accounts + new attempt.
      let executionRef;
      try {
        executionRef = await engineRegistry.trigger("billrun", {
          bill_run_id: run.billRunId,
          period_start: run.periodStart,
          period_end: run.periodEnd,
          ban_ids: banIds,
          attempt: newAttempt,
          gl_event_at: run.glEventAt ?? run.scheduledRunDate,
        });
      } catch (err) {
        throw new EngineUnreachableSignal(
          err instanceof Error ? err.message : "Engine unreachable",
        );
      }

      // Loop the run back to PROCESSING and refresh the derived counters
      // (stored == derived, Inv. #12). The post-bump statuses are known
      // in-memory — the selected accounts are now PROCESSING; every other
      // account keeps the status just read — so no second full-table read is
      // needed.
      const selected = new Set(banIds);
      const postBumpStatuses: AccountStatus[] = accounts.map((a) =>
        selected.has(a.billingAccountId) ? "PROCESSING" : a.status,
      );
      await billRunRepository.markRerunProcessing(tx, run.billRunId, {
        ...computeRunCounters(postBumpStatuses),
        processingExecutionId: executionRef.executionId,
        processingFlowId: executionRef.definitionId,
        processingFlowRevision: executionRef.definitionRevision,
        processingEngineRef: executionRef.engineRef,
      });

      return {
        ok: true,
        value: {
          billRunId: run.billRunId,
          accountCount: banIds.length,
          fromStage: params.fromStage,
          attempt: newAttempt,
          priorTotals,
          executionId: executionRef.executionId,
        },
      } as const;
    });
  } catch (err) {
    if (err instanceof EngineUnreachableSignal) {
      return { ok: false, code: "ENGINE_UNREACHABLE" };
    }
    throw err;
  }
}
