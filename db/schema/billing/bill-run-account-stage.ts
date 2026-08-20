import {
  check,
  date,
  index,
  integer,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { billing } from "@/db/schema/billing/pg-schema";
import { billRun } from "@/db/schema/billing/bill-run";
import { billingAccount } from "@/db/schema/billing/accounts";

// bm04-spec §Design/§Implementation §1-3, plan §6.5. PHYSICAL DDL OF RECORD:
// db/migrations/0028_bill_run_account_stage.sql. PARTITION BY RANGE
// (period_partition) via pg_partman (db/bootstrap/billing-partman-setup.sql),
// following the `bill_run_account`/`audit_log` pattern exactly: Drizzle
// cannot express partitioning or the composite-PK-on-partitioned-table, so
// this declaration exists for query typing only — do not `drizzle-kit push`
// it.
//
// The UNIQUE `(ref_bill_run_id, ref_billing_account_id, stage, attempt,
// period_partition)` is the idempotency latch (architecture Inv. #5) — the
// stage handler inserts this row FIRST inside its transaction; a duplicate
// signal hits this constraint and is caught as a 200 no-op replay, never
// pre-checked for existence. `period_partition` is fixed per run at snapshot
// time (Inv. #11), never insert time.

export const billRunAccountStageSeq = billing.sequence(
  "bill_run_account_stage_seq",
  { startWith: 1 },
);

export const billRunAccountStage = billing.table(
  "bill_run_account_stage",
  {
    billRunAccountStageId: text("bill_run_account_stage_id")
      .notNull()
      .default(
        sql`'BRS' || lpad(nextval('billing.bill_run_account_stage_seq')::text, 8, '0')`,
      ),
    refBillRunId: text("ref_bill_run_id")
      .notNull()
      .references(() => billRun.billRunId, { onDelete: "restrict" }),
    refBillingAccountId: text("ref_billing_account_id")
      .notNull()
      .references(() => billingAccount.billingAccountId, {
        onDelete: "restrict",
      }),
    periodPartition: date("period_partition", { mode: "string" }).notNull(),
    stage: text("stage").notNull(),
    attempt: integer("attempt").notNull(),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }),
    endedAt: timestamp("ended_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }),
    errorClass: text("error_class"),
    errorCode: text("error_code"),
    errorDetail: text("error_detail"),
  },
  (t) => [
    // Composite PK is required because period_partition is the partition key
    // (Postgres requires the partition key in every unique/PK on a
    // partitioned table).
    primaryKey({ columns: [t.billRunAccountStageId, t.periodPartition] }),
    // The idempotency latch (Inv. #5, code-standards §6.5) — do not drop or
    // weaken it.
    unique("bill_run_account_stage_run_ban_stage_attempt_period_unique").on(
      t.refBillRunId,
      t.refBillingAccountId,
      t.stage,
      t.attempt,
      t.periodPartition,
    ),
    index("bill_run_account_stage_ref_bill_run_id_idx").on(t.refBillRunId),
    index("bill_run_account_stage_period_partition_idx").on(t.periodPartition),
    check(
      "bill_run_account_stage_stage_check",
      sql`stage IN ('scoping','validation','collection','aggregation','taxation','verification','posting','rendering','distribution')`,
    ),
    check(
      "bill_run_account_stage_status_check",
      sql`status IN ('PENDING','RUNNING','DONE','FAILED','SKIPPED')`,
    ),
    check(
      "bill_run_account_stage_error_class_check",
      sql`error_class IS NULL OR error_class IN ('HARD','SOFT','INFRA')`,
    ),
  ],
);

export type BillRunAccountStage = typeof billRunAccountStage.$inferSelect;
export type BillRunAccountStageInsert = typeof billRunAccountStage.$inferInsert;
