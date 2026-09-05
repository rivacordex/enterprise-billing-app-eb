import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { accountingPeriodRepository } from "@/db/repositories/accounts/accounting-period.repository";
import { billingAccountRepository } from "@/db/repositories/accounts/billing-account.repository";
import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import { getBusinessToday } from "@/services/billing/business-today";
import { engineRegistry } from "@/services/billing/engine-registry";
import { scopeAccounts } from "@/services/billing/scope-accounts";

// bm03-spec §Design/§7. The trigger transaction: row-locked double-trigger
// guard → scope accounts → PROCESSING + gl_event_at/triggered_by →
// engine.startExecution (inside the txn, resolved decision #3) → store the
// execution ref → BILL_RUN_TRIGGERED audit. A thrown engine failure rolls the
// whole transaction back — the run stays SCHEDULED, no orphan snapshot.
//
// bm12-spec §Design/§Implementation §6. The guard's allowed-from set is
// extended to `CANCELLED` — the Layer-3 escape's re-trigger path (a
// cancelled run "re-materializes the period cleanly" by re-triggering the
// SAME run row, since the `(cycle, period_start)` unique key prevents a
// second one). Re-triggering from CANCELLED re-snapshots fresh under a NEW
// attempt sequence (`maxAttemptForRun` + 1, never the SCHEDULED path's
// hardcoded `1`) so the re-triggered engine's stage signals can never collide
// with `bill_run_account_stage` history left by the killed execution
// (architecture Inv. #5 — the idempotency latch is keyed by attempt). The
// SCHEDULED (first-ever trigger) path is untouched: no prior snapshot exists,
// so the extra queries are skipped and `attempt` stays the literal `1`.

export type TriggerRunResult =
  | {
      ok: true;
      value: {
        billRunId: string;
        banCount: number;
        excludedCount: number;
        executionId: string;
      };
    }
  | { ok: false; code: "NOT_OPERABLE" }
  | { ok: false; code: "NO_ELIGIBLE_ACCOUNTS" }
  | { ok: false; code: "PERIOD_CLOSED" }
  | { ok: false; code: "ENGINE_UNREACHABLE" };

// Internal-only signal thrown from inside `db.transaction` so the engine
// failure rolls the whole txn back (throwing is drizzle's rollback trigger)
// while still letting the outer call return a typed result instead of
// rejecting (bm03-spec §Design — "the engine call is inside the txn").
class EngineUnreachableSignal extends Error {}

export async function triggerRun(
  billRunId: string,
  actorId: string,
  today: string = getBusinessToday(),
): Promise<TriggerRunResult> {
  try {
    return await db.transaction(async (tx) => {
      const run = await billRunRepository.findByIdForUpdate(tx, billRunId);
      if (!run) {
        return { ok: false, code: "NOT_OPERABLE" } as const;
      }
      const startingFromCancelled = run.status === "CANCELLED";
      const eligible =
        (run.status === "SCHEDULED" && run.scheduledRunDate <= today) ||
        startingFromCancelled;
      if (!eligible) {
        return { ok: false, code: "NOT_OPERABLE" } as const;
      }

      // bm12 re-trigger guard: a run's accounting period may have closed while
      // it sat CANCELLED — cancellation consumes no invoice numbers, so a
      // CANCELLED (terminal) run no longer blocks period close
      // (`findActiveForPeriod` excludes it). Re-triggering into a closed period
      // would run the whole pipeline only to have every INV rejected
      // PERIOD_CLOSED at post time, with no reopen path (architecture Inv. #7).
      // Refuse up front, before any scoping/snapshot work. The normal SCHEDULED
      // path materializes into the current (open) period, so it is not guarded.
      if (startingFromCancelled) {
        const currency = await billingAccountRepository.findCurrencyByCycleId(
          tx,
          run.refBillCycleId,
        );
        if (currency) {
          const period = run.scheduledRunDate.slice(0, 7);
          const periodRow =
            await accountingPeriodRepository.findByPeriodAndCurrency(
              tx,
              period,
              currency,
            );
          if (periodRow?.state === "closed") {
            return { ok: false, code: "PERIOD_CLOSED" } as const;
          }
        }
      }

      const { pending, excluded } = await scopeAccounts(tx, {
        billRunId: run.billRunId,
        refBillCycleId: run.refBillCycleId,
        periodStart: run.periodStart,
        periodEnd: run.periodEnd,
      });

      if (pending.length === 0) {
        return { ok: false, code: "NO_ELIGIBLE_ACCOUNTS" } as const;
      }

      // A cancelled-then-re-triggered run re-snapshots fresh under a new
      // attempt sequence — clear the prior (killed) snapshot and bump past
      // its highest recorded attempt so this execution's stage signals never
      // collide with the killed execution's `bill_run_account_stage` history.
      // The normal SCHEDULED path never has a prior snapshot, so `attempt`
      // stays `1` and every row is inserted exactly as before (unchanged).
      let attempt = 1;
      let snapshotRows = [...pending, ...excluded];
      if (startingFromCancelled) {
        attempt =
          (await billRunAccountRepository.maxAttemptForRun(tx, run.billRunId)) +
          1;
        await billRunAccountRepository.deleteForRun(tx, run.billRunId);
        // Clear the killed attempt's UNPOSTED trial bills too — the snapshot is
        // rebuilt below, but a bill for an account that re-scopes EXCLUDED/failed
        // on the new attempt would otherwise be orphaned on the Bills tab.
        await customerBillRepository.deleteUnpostedForRun(tx, run.billRunId);
        snapshotRows = snapshotRows.map((row) => ({
          ...row,
          attemptCount: attempt,
        }));
      }

      await billRunAccountRepository.insertSnapshot(tx, snapshotRows);

      const banIds = pending.map((p) => p.refBillingAccountId);
      let executionRef;
      try {
        executionRef = await engineRegistry.trigger("billrun", {
          bill_run_id: run.billRunId,
          period_start: run.periodStart,
          period_end: run.periodEnd,
          ban_ids: banIds,
          attempt,
          gl_event_at: run.scheduledRunDate,
        });
      } catch (err) {
        throw new EngineUnreachableSignal(
          err instanceof Error ? err.message : "Engine unreachable",
        );
      }

      await billRunRepository.markProcessing(tx, run.billRunId, {
        glEventAt: run.scheduledRunDate,
        triggeredBy: actorId,
        processingExecutionId: executionRef.executionId,
        processingFlowId: executionRef.definitionId,
        processingFlowRevision: executionRef.definitionRevision,
        processingEngineRef: executionRef.engineRef,
      });

      await insertAuditEvent(tx, {
        eventType: "BILL_RUN_TRIGGERED",
        actorUserId: actorId,
        targetEntity: "BILL_RUN",
        targetId: run.billRunId,
        beforeData: null,
        afterData: {
          banCount: pending.length,
          excludedCount: excluded.length,
          executionId: executionRef.executionId,
        },
      });

      return {
        ok: true,
        value: {
          billRunId: run.billRunId,
          banCount: pending.length,
          excludedCount: excluded.length,
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
