import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import { aggregateBill } from "@/services/billing/aggregate-bill";
import { computeRunCounters } from "@/services/billing/compute-run-status";
import { getEngineClient } from "@/services/billing/engine-client";
import { taxBill } from "@/services/billing/taxation";
import { STAGES } from "@/types/billing";
import type { AccountStatus } from "@/types/billing";
import type { RerunStage } from "@/validation/billing/rerun-run.schema";

// bm08-spec §Design/§Implementation §1. The rerun transaction — pre-approval
// only. In one `db.transaction`, in this order:
//   1. AUDIT FIRST — write the `BILL_RUN_RERUN` row (prior totals + reason)
//      BEFORE any re-trigger (architecture Inv.; code-standards §1.10).
//   2. `attempt_count += 1` for the selected accounts; drop them to PROCESSING.
//   3. Invalidate later stages — implicit: `bill_run_account_stage` is keyed by
//      `attempt`, so the bumped attempt makes every new signal from the chosen
//      stage onward land on a fresh row; prior-attempt rows stay as history.
//   4. Re-derive the trial bills (Aggregation/Taxation) for the rerun accounts
//      that ALREADY HAVE an unposted bill (i.e. previously reached Aggregation),
//      via the conditional `DELETE … WHERE ref_inv_document_id IS NULL` + INSERT
//      (bm05/bm06) — from the chosen stage onward only. An account with no bill
//      yet (e.g. failed at Validation) is NOT billed inline — the re-triggered
//      engine re-validates and creates it through the single validated
//      `handle-stage-signal` path. A posted bill is never touched (Inv. #4).
//   5. Claim release/re-claim — v1 no-op (no `rating` table).
//   6. Re-trigger the engine (stub) scoped to the rerun accounts + new attempt.
// The engine call is inside the txn (bm03 pattern): a failure rolls the whole
// rerun back — the audit row, the attempt bump, and the re-derivation all
// vanish, and the run stays as it was.

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
      // three reads are all keyed only on the run and independent — issue them
      // together. `accounts` (all accounts, incl. `EXCLUDED`) also feeds the
      // in-memory counter recompute below, so no second status read is needed.
      const [accounts, postedIds, unpostedBillIds] = await Promise.all([
        billRunAccountRepository.listForRerun(tx, run.billRunId),
        customerBillRepository.listPostedAccountIds(tx, run.billRunId),
        customerBillRepository.listUnpostedBillAccountIds(tx, run.billRunId),
      ]);
      const posted = new Set(postedIds);
      const hasUnpostedBill = new Set(unpostedBillIds);
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

      // 2 + 3. Bump the attempt (invalidating later stages via the attempt-keyed
      // latch) and drop the selected accounts back to PROCESSING.
      await billRunAccountRepository.incrementAttemptForRerun(
        tx,
        run.billRunId,
        banIds,
      );

      // 4. Re-derive the trial bills from the chosen stage onward, ONLY for
      // accounts that already have an unposted bill (they previously reached
      // Aggregation). Aggregation rewrites the bill; Taxation re-taxes it — both
      // rerun-safe (`ref_inv_document_id IS NULL` guard). Gating on an existing
      // bill keeps this from (a) writing a trial bill for an account that never
      // passed Validation — the re-triggered engine re-validates and creates it
      // through `handle-stage-signal`, the single validated path — and (b)
      // calling `taxBill` with no bill to tax, which throws and would roll the
      // whole rerun back. A rerun from `verification` re-derives nothing; from
      // `taxation` re-taxes; from `aggregation`/`collection`/`validation` rewrites
      // then re-taxes.
      const from = STAGES.indexOf(params.fromStage);
      const reAggregate = from <= STAGES.indexOf("aggregation");
      const reTax = from <= STAGES.indexOf("taxation");
      for (const banId of banIds) {
        if (!hasUnpostedBill.has(banId)) continue;
        if (reAggregate) await aggregateBill(tx, run, banId);
        if (reTax) await taxBill(tx, run, banId);
      }

      // 5. Claim release/re-claim — v1 no-op.
      // deferred: with the rating engine this releases the prior attempt's UDR
      // claim and re-claims under the new attempt (Inv. #2).

      // 6. Re-trigger the engine (stub) scoped to the rerun accounts + attempt.
      let executionRef;
      try {
        executionRef = await getEngineClient().startExecution({
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
        workflowExecutionId: executionRef.executionId,
        workflowDefinitionId: executionRef.definitionId,
        workflowDefinitionRevision: executionRef.definitionRevision,
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
