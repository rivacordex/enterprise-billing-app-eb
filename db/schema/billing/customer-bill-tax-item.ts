import {
  date,
  foreignKey,
  index,
  numeric,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { billing } from "@/db/schema/billing/pg-schema";
import { customerBill } from "@/db/schema/billing/customer-bill";

// bm06-spec §Design/§Implementation §1, plan §6.4. PHYSICAL DDL OF RECORD:
// db/migrations/0030_customer_bill_tax_item.sql. PARTITION BY RANGE
// (period_partition) via pg_partman (db/bootstrap/billing-partman-setup.sql),
// following the `customer_bill`/`bill_run_account_stage` pattern exactly:
// Drizzle cannot express partitioning or the composite-PK-on-partitioned-table,
// so this declaration exists for query typing only — do not `drizzle-kit push`
// it.
//
// A first-class table, NEVER JSONB — tax is financially significant (code-
// standards §6.12, plan §6.4). One row per (bill, tax category); v1 writes a
// single SST row per bill, but the shape supports multiple categories, and the
// bill's `tax_total` is always the SQL SUM of its items, never a scalar
// shortcut. The composite FK includes `period_partition` because the parent
// `customer_bill` PK does (Postgres requires the partition key in every FK to a
// partitioned table).

export const customerBillTaxItemSeq = billing.sequence(
  "customer_bill_tax_item_seq",
  { startWith: 1 },
);

export const customerBillTaxItem = billing.table(
  "customer_bill_tax_item",
  {
    customerBillTaxItemId: text("customer_bill_tax_item_id")
      .notNull()
      .default(
        sql`'CBT' || lpad(nextval('billing.customer_bill_tax_item_seq')::text, 8, '0')`,
      ),
    refCustomerBillId: text("ref_customer_bill_id").notNull(),
    periodPartition: date("period_partition", { mode: "string" }).notNull(),
    taxCategory: text("tax_category").notNull(),
    taxRate: numeric("tax_rate", {
      mode: "string",
      precision: 5,
      scale: 2,
    }).notNull(),
    taxAmount: numeric("tax_amount", {
      mode: "string",
      precision: 18,
      scale: 2,
    }).notNull(),
  },
  (t) => [
    // Composite PK is required because period_partition is the partition key
    // (Postgres requires the partition key in every unique/PK on a
    // partitioned table).
    primaryKey({ columns: [t.customerBillTaxItemId, t.periodPartition] }),
    // Composite FK to the (also-partitioned) `customer_bill`, keyed on its full
    // PK `(customer_bill_id, period_partition)` — a tax item can never outlive
    // or precede its bill.
    foreignKey({
      columns: [t.refCustomerBillId, t.periodPartition],
      foreignColumns: [
        customerBill.customerBillId,
        customerBill.periodPartition,
      ],
      name: "customer_bill_tax_item_customer_bill_fk",
    }).onDelete("restrict"),
    index("customer_bill_tax_item_ref_customer_bill_id_idx").on(
      t.refCustomerBillId,
    ),
    index("customer_bill_tax_item_period_partition_idx").on(t.periodPartition),
  ],
);

export type CustomerBillTaxItem = typeof customerBillTaxItem.$inferSelect;
export type CustomerBillTaxItemInsert = typeof customerBillTaxItem.$inferInsert;
