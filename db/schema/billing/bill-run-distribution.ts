import {
  boolean,
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

// bm20-spec §Implementation §1. PHYSICAL DDL OF RECORD:
// db/migrations/0038_bill_run_distribution.sql. PARTITION BY RANGE
// (period_partition) via pg_partman (db/bootstrap/billing-partman-setup.sql),
// following the `bill_run_invoices` pattern exactly: Drizzle cannot express
// partitioning or the composite-PK-on-partitioned-table, so this declaration
// exists for query typing only — do not `drizzle-kit push` it.
//
// One row per per-artifact-per-target delivery outcome the distribution flow
// signals — the delivery log AND the idempotency latch in one table (the
// same "one table, two jobs" shape as `bill_run_account_stage`). App-owned
// (`app_runtime` write; `billrun_runtime` holds no grant, bm14 Step 9's
// pattern for a phase-2-only table).

export const billRunDistributionSeq = billing.sequence(
  "bill_run_distribution_seq",
  { startWith: 1 },
);

export const billRunDistribution = billing.table(
  "bill_run_distribution",
  {
    billRunDistributionId: text("bill_run_distribution_id")
      .notNull()
      .default(
        sql`'BRD' || lpad(nextval('billing.bill_run_distribution_seq')::text, 8, '0')`,
      ),
    refBillRunId: text("ref_bill_run_id")
      .notNull()
      .references(() => billRun.billRunId, { onDelete: "restrict" }),
    // The target name (e.g. "loopback") — deliberately unconstrained text,
    // not a domain-union CHECK: real targets (portal/AR feed/statutory/email)
    // are configured, not enumerated in code (Inv. #11's "no udr_mode-style
    // column" posture — no target-catalog table exists to enumerate against).
    target: text("target").notNull(),
    // A `bill_run_invoice_id` (BRI…) for an `invoice_pdf` artifact, or the
    // fixed report artifact-ref constant for the one `report_csv` artifact
    // (`REPORT_ARTIFACT_REF`, distribute-run.ts) — deliberately not an FK: the
    // report has no stored row to reference (D21).
    artifactRef: text("artifact_ref").notNull(),
    artifactType: text("artifact_type").notNull(),
    isMandatory: boolean("is_mandatory").notNull(),
    outcome: text("outcome").notNull(),
    at: timestamp("at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
    // bm20-spec §Implementation §1 T1 — the redelivery round, bumped by
    // `rerunDistribution`. Part of the idempotency UNIQUE below so a rerun's
    // outcome is a fresh row, never a dropped replay of the prior attempt.
    distributionAttempt: integer("distribution_attempt").notNull(),
    periodPartition: date("period_partition", { mode: "string" }).notNull(),
  },
  (t) => [
    // Composite PK is required because period_partition is the partition key
    // (Postgres requires the partition key in every unique/PK on a
    // partitioned table).
    primaryKey({ columns: [t.billRunDistributionId, t.periodPartition] }),
    // The idempotency latch (Inv. #5's shape, extended by T1): a replay of
    // the SAME round is a no-op; a NEW `distribution_attempt` (a rerun) is a
    // fresh row.
    unique(
      "bill_run_distribution_run_target_artifact_attempt_period_unique",
    ).on(
      t.refBillRunId,
      t.target,
      t.artifactRef,
      t.distributionAttempt,
      t.periodPartition,
    ),
    check(
      "bill_run_distribution_artifact_type_check",
      sql`artifact_type IN ('invoice_pdf','report_csv')`,
    ),
    check(
      "bill_run_distribution_outcome_check",
      sql`outcome IN ('DELIVERED','FAILED')`,
    ),
    index("bill_run_distribution_ref_bill_run_id_idx").on(t.refBillRunId),
    index("bill_run_distribution_period_partition_idx").on(t.periodPartition),
  ],
);

export type BillRunDistribution = typeof billRunDistribution.$inferSelect;
export type BillRunDistributionInsert = typeof billRunDistribution.$inferInsert;
