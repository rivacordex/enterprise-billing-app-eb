import { and, asc, count, desc, eq, inArray, notInArray } from "drizzle-orm";

import type { Database } from "@/db/client";
import { billRun } from "@/db/schema/billing/bill-run";
import { billCycle } from "@/db/schema/billing/catalogs";
import { TERMINAL_RUN_STATUSES } from "@/types/billing";

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
};
