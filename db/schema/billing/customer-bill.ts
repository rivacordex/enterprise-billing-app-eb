import {
  check,
  date,
  index,
  integer,
  numeric,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { billing } from "@/db/schema/billing/pg-schema";
import { billRun } from "@/db/schema/billing/bill-run";
import { billingAccount } from "@/db/schema/billing/accounts";

// bm05-spec §Design/§Implementation §1, plan §6.3. PHYSICAL DDL OF RECORD:
// db/migrations/0029_customer_bill.sql. PARTITION BY RANGE (period_partition)
// via pg_partman (db/bootstrap/billing-partman-setup.sql), following the
// `bill_run_account`/`bill_run_account_stage` pattern exactly: Drizzle cannot
// express partitioning or the composite-PK-on-partitioned-table, so this
// declaration exists for query typing only — do not `drizzle-kit push` it.
//
// `ref_bill_format_id`/`ref_bill_template_version_id` are reserved, nullable,
// carry NO FK (the catalog/rendering phase is deferred). `ref_inv_document_id`
// is the finalization latch (architecture Inv. #4) — a row with it set is
// never UPDATEd/DELETEd; Aggregation's rerun-safe write is a conditional
// `DELETE ... WHERE ref_inv_document_id IS NULL` + INSERT
// (`services/billing/aggregate-bill.ts`), never an unconditional delete.
// `posted_attempt`/`charge_checksum` stay NULL until posting (bm11) — there is
// no billing-side charge copy (Module Inv. #3).

export const customerBillSeq = billing.sequence("customer_bill_seq", {
  startWith: 1,
});

export const customerBill = billing.table(
  "customer_bill",
  {
    customerBillId: text("customer_bill_id")
      .notNull()
      .default(
        sql`'CBL' || lpad(nextval('billing.customer_bill_seq')::text, 8, '0')`,
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
    category: text("category").notNull(),
    state: text("state").notNull().default("new"),
    billingPeriodStart: date("billing_period_start", {
      mode: "string",
    }).notNull(),
    billingPeriodEnd: date("billing_period_end", { mode: "string" }).notNull(),
    subtotal: numeric("subtotal", {
      mode: "string",
      precision: 18,
      scale: 2,
    }).notNull(),
    taxTotal: numeric("tax_total", {
      mode: "string",
      precision: 18,
      scale: 2,
    }).notNull(),
    totalAmount: numeric("total_amount", {
      mode: "string",
      precision: 18,
      scale: 2,
    }).notNull(),
    paymentDueDate: date("payment_due_date", { mode: "string" }).notNull(),
    // Reserved — catalog/rendering phase deferred. No FK.
    refBillFormatId: text("ref_bill_format_id"),
    refBillTemplateVersionId: text("ref_bill_template_version_id"),
    // The finalization latch (Inv. #4), written at posting (bm11).
    refInvDocumentId: text("ref_inv_document_id"),
    postedAttempt: integer("posted_attempt"),
    chargeChecksum: text("charge_checksum"),
  },
  (t) => [
    // Composite PK is required because period_partition is the partition key
    // (Postgres requires the partition key in every unique/PK on a
    // partitioned table).
    primaryKey({ columns: [t.customerBillId, t.periodPartition] }),
    unique("customer_bill_run_ban_period_unique").on(
      t.refBillRunId,
      t.refBillingAccountId,
      t.periodPartition,
    ),
    index("customer_bill_ref_bill_run_id_idx").on(t.refBillRunId),
    index("customer_bill_period_partition_idx").on(t.periodPartition),
    check(
      "customer_bill_category_check",
      sql`category IN ('trial','normal','last')`,
    ),
    check(
      "customer_bill_state_check",
      sql`state IN ('new','validated','sent')`,
    ),
  ],
);

export type CustomerBill = typeof customerBill.$inferSelect;
export type CustomerBillInsert = typeof customerBill.$inferInsert;
