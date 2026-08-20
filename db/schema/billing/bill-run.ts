import {
  check,
  date,
  integer,
  numeric,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { appuser } from "@/db/schema/identity";
import { billing } from "@/db/schema/billing/pg-schema";
import { billCycle } from "@/db/schema/billing/catalogs";

// bm02-spec §1. The bill-run header — one low-volume row per run, NOT
// partitioned (architecture §3; only the four record tables are). The full
// header column set from plan §6.1 is created up front (a documented
// exception to strict just-in-time) to avoid churny ALTERs across later
// units; bm02 only ever populates the materialize subset
// (`ref_bill_cycle_id`, `period_start`, `period_end`, `scheduled_run_date`,
// `status`, `run_type`, `created_at`). Every other column is nullable and is
// written by a later unit (trigger writes `triggered_by`/`gl_event_at`/…,
// approve writes `approved_by`/`total_amount`, the timeline stamps, etc.).
//
// There is NO billing-side charge copy (Module Inv. #3) — no amount column
// here holds a charge; `total_amount` is the run-level stamp written at
// APPROVED by a later unit, never in bm02.

export const billRunSeq = billing.sequence("bill_run_seq", { startWith: 1 });

export const billRun = billing.table(
  "bill_run",
  {
    billRunId: text("bill_run_id")
      .primaryKey()
      .default(
        sql`'BRN' || lpad(nextval('billing.bill_run_seq')::text, 8, '0')`,
      ),
    refBillCycleId: text("ref_bill_cycle_id")
      .notNull()
      .references(() => billCycle.billCycleId, { onDelete: "restrict" }),
    // Calendar dates (no timezone) — the in-arrears window (code-standards
    // §2.5). `scheduled_run_date = period_end + 1`.
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),
    scheduledRunDate: date("scheduled_run_date", { mode: "string" }).notNull(),
    status: text("status").notNull().default("SCHEDULED"),
    runType: text("run_type").notNull().default("onCycle"),
    // --- populated by later units (nullable now) ---
    workflowExecutionId: text("workflow_execution_id"),
    workflowDefinitionId: text("workflow_definition_id"),
    workflowDefinitionRevision: integer("workflow_definition_revision"),
    lastProgressAt: timestamp("last_progress_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }),
    glEventAt: date("gl_event_at", { mode: "string" }),
    refTaxRateVersion: text("ref_tax_rate_version"),
    banCount: integer("ban_count"),
    ratedCount: integer("rated_count"),
    failedCount: integer("failed_count"),
    totalAmount: numeric("total_amount", {
      mode: "string",
      precision: 18,
      scale: 2,
    }),
    triggeredBy: text("triggered_by").references(() => appuser.id, {
      onDelete: "restrict",
    }),
    approvedBy: text("approved_by").references(() => appuser.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
    // Timeline stamps — one per lifecycle transition, written by later units.
    processedAt: timestamp("processed_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }),
    approvedAt: timestamp("approved_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }),
    postingStartedAt: timestamp("posting_started_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }),
    invoicedAt: timestamp("invoiced_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }),
    distributingAt: timestamp("distributing_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }),
  },
  (t) => [
    // The idempotency latch for lazy materialization (Inv. #10, overview
    // success criterion 1): concurrent list loads INSERT … ON CONFLICT on
    // this constraint, so exactly one row exists per cycle-period.
    unique("bill_run_cycle_period_unique").on(t.refBillCycleId, t.periodStart),
    check(
      "bill_run_status_check",
      sql`status IN ('SCHEDULED','PROCESSING','PROCESSED','APPROVED','POSTING','INVOICED','DISTRIBUTING','COMPLETED','PROCESSING_FAILED','DISTRIBUTION_FAILED','CANCELLED')`,
    ),
    check("bill_run_run_type_check", sql`run_type IN ('onCycle','offCycle')`),
    // Four-eyes at the DB backstop (Inv. #8) — the approver can never be the
    // trigger actor. The service layer is the primary check.
    check(
      "bill_run_approver_distinct_check",
      sql`approved_by IS NULL OR approved_by <> triggered_by`,
    ),
    // Period-window invariants (bm02-spec Design §Structural). `period_start`
    // never past `period_end` holds for any run type; the in-arrears
    // `scheduled_run_date = period_end + 1` is an on-cycle rule, so it is
    // guarded on `run_type = 'onCycle'` (all bm02 writes) and left open for the
    // modelled off-cycle runs later.
    check("bill_run_period_order_check", sql`period_start <= period_end`),
    check(
      "bill_run_oncycle_schedule_check",
      sql`run_type <> 'onCycle' OR scheduled_run_date = period_end + 1`,
    ),
  ],
);

export type BillRun = typeof billRun.$inferSelect;
export type BillRunInsert = typeof billRun.$inferInsert;
