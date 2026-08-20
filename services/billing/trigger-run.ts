import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { getBusinessToday } from "@/services/billing/business-today";
import { getEngineClient } from "@/services/billing/engine-client";
import { scopeAccounts } from "@/services/billing/scope-accounts";

// bm03-spec §Design/§7. The trigger transaction: row-locked double-trigger
// guard → scope accounts → PROCESSING + gl_event_at/triggered_by →
// engine.startExecution (inside the txn, resolved decision #3) → store the
// execution ref → BILL_RUN_TRIGGERED audit. A thrown engine failure rolls the
// whole transaction back — the run stays SCHEDULED, no orphan snapshot.

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
      if (!run || run.status !== "SCHEDULED" || run.scheduledRunDate > today) {
        return { ok: false, code: "NOT_OPERABLE" } as const;
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

      await billRunAccountRepository.insertSnapshot(tx, [
        ...pending,
        ...excluded,
      ]);

      const banIds = pending.map((p) => p.refBillingAccountId);
      let executionRef;
      try {
        executionRef = await getEngineClient().startExecution({
          bill_run_id: run.billRunId,
          period_start: run.periodStart,
          period_end: run.periodEnd,
          ban_ids: banIds,
          attempt: 1,
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
        workflowExecutionId: executionRef.executionId,
        workflowDefinitionId: executionRef.definitionId,
        workflowDefinitionRevision: executionRef.definitionRevision,
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
