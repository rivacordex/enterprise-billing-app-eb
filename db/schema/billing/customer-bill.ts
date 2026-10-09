import {
  check,
  date,
  foreignKey,
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
// `ref_bill_format_id`/`ref_bill_template_version_id` (and bm50's
// `ref_invoice_profile_version`/`ref_csv_template_version_id`) are nullable,
// carry NO FK, and are stamped at posting by the app (bm54, `stampPosted`).
// `ref_inv_document_id`
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
    refBillingAccountId: text("ref_billing_account_id").notNull(),
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
    // Invoice-template posting stamps (Inv. #41) — stamped at posting by the
    // app (bm54): `stampPosted` writes all four in the same UPDATE as
    // `ref_inv_document_id`, from the rows `resolveVersionsForPosting`
    // resolved, then the finalization guard (0033) freezes them. No FK
    // (partitioned table + the plain-key stamp rule, 0029 precedent).
    // `billrun_runtime` lost its column grants on the first two (bm50, Inv
    // #41) — these are app-only. NULL on every bill posted before bm54.
    refBillFormatId: text("ref_bill_format_id"),
    refBillTemplateVersionId: text("ref_bill_template_version_id"),
    // bm50-spec §Design D6 — the company-profile `config_version` (NULL when
    // no profile was ACTIVE at posting, G15 A) and the CSV version id;
    // nullable, no FK, app-only stamps, stamped at posting by the app (bm54).
    refInvoiceProfileVersion: integer("ref_invoice_profile_version"),
    refCsvTemplateVersionId: text("ref_csv_template_version_id"),
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
    // Explicit FK name — Drizzle's derived name exceeds Postgres's 63-byte
    // identifier cap (code-standards §"Constraint & index naming").
    foreignKey({
      columns: [t.refBillingAccountId],
      foreignColumns: [billingAccount.billingAccountId],
      name: "customer_bill_ref_billing_account_id_fk",
    }).onDelete("restrict"),
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
