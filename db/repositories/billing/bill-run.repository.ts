import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  notInArray,
  sql,
} from "drizzle-orm";

import type { Database } from "@/db/client";
import { billRun } from "@/db/schema/billing/bill-run";
import type { BillRun } from "@/db/schema/billing/bill-run";
import { billCycle } from "@/db/schema/billing/catalogs";
import { TERMINAL_RUN_STATUSES } from "@/types/billing";
import type { RunStatus } from "@/types/billing";

// bm02-spec §4. Repository for the `billing.bill_run` header. `insertMissingRuns`
// is the idempotent, concurrency-safe materialize write (the UNIQUE constraint
// + ON CONFLICT DO NOTHING); `listRuns` backs the two-tab read. No money math,
// no status recomputation here — pure SQL (code-standards §3.1).

export interface MaterializeRunInput {
  refBillCycleId: string;
  periodStart: string;
  periodEnd: string;
  scheduledRunDate: string;
}

export interface InsertedRun {
  billRunId: string;
  refBillCycleId: string;
  periodStart: string;
  periodEnd: string;
  scheduledRunDate: string;
}

export interface BillRunRepoRow {
  billRunId: string;
  refBillCycleId: string;
  cycleName: string;
  periodStart: string;
  periodEnd: string;
  scheduledRunDate: string;
  status: string;
  runType: string;
}

export interface RunFilters {
  tab: "current" | "historical";
  cycleId: string | null;
  status: string | null;
}

export interface ListRunsOptions extends RunFilters {
  // `null` = no pagination (Current & Upcoming is grouped, and the CSV export
  // pulls the full filtered set — bm02-spec §5/§7).
  limit: number | null;
  offset: number;
}

const TERMINAL = [...TERMINAL_RUN_STATUSES];

// Tab + optional cycle/status filters, shared by the count and the rows read.
function buildWhere(filters: RunFilters) {
  const conditions = [
    filters.tab === "historical"
      ? inArray(billRun.status, TERMINAL)
      : notInArray(billRun.status, TERMINAL),
  ];
  if (filters.cycleId)
    conditions.push(eq(billRun.refBillCycleId, filters.cycleId));
  if (filters.status) conditions.push(eq(billRun.status, filters.status));
  return and(...conditions);
}

export const billRunRepository = {
  // Inserts one row per due period, skipping any that already exist under the
  // `(ref_bill_cycle_id, period_start)` UNIQUE — so two concurrent list loads
  // produce exactly one row per period (Inv. #10, overview success criterion
  // 1). `RETURNING` yields ONLY the rows actually inserted, which is what the
  // materialize service audits (a no-op load returns an empty array).
  async insertMissingRuns(
    db: Database,
    rows: MaterializeRunInput[],
  ): Promise<InsertedRun[]> {
    if (rows.length === 0) return [];
    return db
      .insert(billRun)
      .values(rows)
      .onConflictDoNothing({
        target: [billRun.refBillCycleId, billRun.periodStart],
      })
      .returning({
        billRunId: billRun.billRunId,
        refBillCycleId: billRun.refBillCycleId,
        periodStart: billRun.periodStart,
        periodEnd: billRun.periodEnd,
        scheduledRunDate: billRun.scheduledRunDate,
      });
  },

  // Count of matching runs — issued ONLY when the caller paginates (Historical
  // tab). The Current tab and the CSV export skip it (no pagination), avoiding
  // a discarded COUNT(*) on the hot path.
  async countRuns(db: Database, filters: RunFilters): Promise<number> {
    const [countRow] = await db
      .select({ total: count() })
      .from(billRun)
      .where(buildWhere(filters));
    return countRow?.total ?? 0;
  },

  // Tab-filtered rows joined to the cycle name. Current & Upcoming = every
  // non-terminal run (grouped/operability resolved in the service); Historical
  // = the two terminal states (COMPLETED/CANCELLED), most-recent first. `limit`
  // null = the full filtered set (grouped Current view + CSV export).
  async listRuns(
    db: Database,
    opts: ListRunsOptions,
  ): Promise<BillRunRepoRow[]> {
    const order =
      opts.tab === "historical"
        ? [desc(billRun.scheduledRunDate), asc(billCycle.name)]
        : [asc(billCycle.name), asc(billRun.scheduledRunDate)];

    const base = db
      .select({
        billRunId: billRun.billRunId,
        refBillCycleId: billRun.refBillCycleId,
        cycleName: billCycle.name,
        periodStart: billRun.periodStart,
        periodEnd: billRun.periodEnd,
        scheduledRunDate: billRun.scheduledRunDate,
        status: billRun.status,
        runType: billRun.runType,
      })
      .from(billRun)
      .innerJoin(billCycle, eq(billRun.refBillCycleId, billCycle.billCycleId))
      .where(buildWhere(opts))
      .orderBy(...order)
      .$dynamic();

    return opts.limit !== null
      ? base.limit(opts.limit).offset(opts.offset)
      : base;
  },

  // bm03-spec §Design — the trigger transaction's double-trigger guard: locks
  // the run row so a concurrent second click blocks then bounces on the
  // `status = 'SCHEDULED'` check (findByIdForUpdate + accounts.repository's
  // FOR UPDATE precedent).
  async findByIdForUpdate(
    tx: Database,
    billRunId: string,
  ): Promise<BillRun | null> {
    const [row] = await tx
      .select()
      .from(billRun)
      .where(eq(billRun.billRunId, billRunId))
      .for("update")
      .limit(1);
    return row ?? null;
  },

  // bm03-spec §Design/§7 — the trigger write: SCHEDULED → PROCESSING, resolves
  // `gl_event_at = scheduled_run_date` (never recomputed after, code-standards
  // §2.5), stamps `triggered_by`/`last_progress_at`, and stores the (stub or
  // real) engine execution reference.
  async markProcessing(
    tx: Database,
    billRunId: string,
    data: {
      glEventAt: string;
      triggeredBy: string;
      workflowExecutionId: string;
      workflowDefinitionId: string;
      workflowDefinitionRevision: number;
    },
  ): Promise<void> {
    await tx
      .update(billRun)
      .set({
        status: "PROCESSING",
        glEventAt: data.glEventAt,
        triggeredBy: data.triggeredBy,
        lastProgressAt: sql`now()`,
        workflowExecutionId: data.workflowExecutionId,
        workflowDefinitionId: data.workflowDefinitionId,
        workflowDefinitionRevision: data.workflowDefinitionRevision,
      })
      .where(eq(billRun.billRunId, billRunId));
  },

  // bm04-spec §Design/§Implementation §8. Reads the run row joined to its
  // cycle for the detail page header (`RunDetail`). No status recompute, no
  // money math — a plain read.
  async findDetailById(
    db: Database,
    billRunId: string,
  ): Promise<{
    billRunId: string;
    cycleName: string;
    periodStart: string;
    periodEnd: string;
    scheduledRunDate: string;
    status: string;
  } | null> {
    const [row] = await db
      .select({
        billRunId: billRun.billRunId,
        cycleName: billCycle.name,
        periodStart: billRun.periodStart,
        periodEnd: billRun.periodEnd,
        scheduledRunDate: billRun.scheduledRunDate,
        status: billRun.status,
      })
      .from(billRun)
      .innerJoin(billCycle, eq(billRun.refBillCycleId, billCycle.billCycleId))
      .where(eq(billRun.billRunId, billRunId))
      .limit(1);
    return row ?? null;
  },

  // bm04-spec §Design/§Implementation §8. The stage handler's run-status
  // recompute: always bumps the heartbeat (`last_progress_at`, overview
  // "Health and recovery"); when `newStatus` is non-null (every account
  // terminal — `computeRunStatus`), also flips the run and stamps
  // `processed_at`. The optional ban_count/rated_count/failed_count cache is
  // refreshed here from the SAME derived counts the caller already computed
  // — never re-derived independently, so stored == derived by construction
  // (architecture Inv. #12).
  async recomputeStatus(
    tx: Database,
    billRunId: string,
    data: {
      newStatus: RunStatus | null;
      banCount: number;
      ratedCount: number;
      failedCount: number;
    },
  ): Promise<void> {
    await tx
      .update(billRun)
      .set({
        ...(data.newStatus
          ? { status: data.newStatus, processedAt: sql`now()` }
          : {}),
        lastProgressAt: sql`now()`,
        banCount: data.banCount,
        ratedCount: data.ratedCount,
        failedCount: data.failedCount,
      })
      .where(eq(billRun.billRunId, billRunId));
  },

  // bm04-spec §Implementation §8. The status-push handler's execution-failure
  // write — bumps the heartbeat and flips the run to the rerunnable
  // PROCESSING_FAILED terminal state.
  async markProcessingFailed(tx: Database, billRunId: string): Promise<void> {
    await tx
      .update(billRun)
      .set({ status: "PROCESSING_FAILED", lastProgressAt: sql`now()` })
      .where(eq(billRun.billRunId, billRunId));
  },
};
