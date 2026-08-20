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

// bm03-spec §1/§6.2. PHYSICAL DDL OF RECORD: db/migrations/0027_bill_run_account.sql
// This table is PARTITION BY RANGE (period_partition) via pg_partman
// (db/bootstrap/billing-partman-setup.{sql,ts}), following the `audit_log`
// pattern exactly (db/schema/audit.ts): Drizzle cannot express partitioning or
// the composite-PK-on-partitioned-table, so this declaration exists for query
// typing only — do not `drizzle-kit push` it.
//
// `period_partition` is fixed per run at snapshot time — the 1st of the run's
// period month, stamped from the parent `bill_run.period_start` — never insert
// time (architecture Inv. #11), so a cross-month rerun keeps every row in one
// partition.

export const billRunAccountSeq = billing.sequence("bill_run_account_seq", {
  startWith: 1,
});

export const billRunAccount = billing.table(
  "bill_run_account",
  {
    billRunAccountId: text("bill_run_account_id")
      .notNull()
      .default(
        sql`'BRA' || lpad(nextval('billing.bill_run_account_seq')::text, 8, '0')`,
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
    status: text("status").notNull().default("PENDING"),
    attemptCount: integer("attempt_count").notNull().default(1),
    errorCode: text("error_code"),
    errorDetail: text("error_detail"),
    lastProcessedAt: timestamp("last_processed_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    }),
  },
  (t) => [
    // Composite PK is required because period_partition is the partition key
    // (Postgres requires the partition key in every unique/PK on a
    // partitioned table).
    primaryKey({ columns: [t.billRunAccountId, t.periodPartition] }),
    // The scoping snapshot's idempotency shape (bm03-spec §1): one row per
    // account per run per period.
    unique("bill_run_account_run_ban_period_unique").on(
      t.refBillRunId,
      t.refBillingAccountId,
      t.periodPartition,
    ),
    index("bill_run_account_ref_bill_run_id_idx").on(t.refBillRunId),
    index("bill_run_account_period_partition_idx").on(t.periodPartition),
    check(
      "bill_run_account_status_check",
      sql`status IN ('PENDING','PROCESSING','PROCESSED','INVOICED','DISTRIBUTING','COMPLETED','PROCESSING_FAILED','DISTRIBUTION_FAILED','SKIPPED','EXCLUDED')`,
    ),
  ],
);

export type BillRunAccount = typeof billRunAccount.$inferSelect;
export type BillRunAccountInsert = typeof billRunAccount.$inferInsert;
