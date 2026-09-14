import { char, date, integer, numeric, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { billing } from "@/db/schema/billing/pg-schema";

// bm23-spec §Design/§Implementation §2, plan §6.3 (D5/D7). PHYSICAL DDL OF
// RECORD: db/migrations/0039_customer_bill_line.sql. PARTITION BY RANGE
// (period_partition) via pg_partman (db/bootstrap/billing-partman-setup.sql),
// following the `customer_bill` (0029) pattern exactly: Drizzle cannot express
// partitioning, the composite-PK-on-partitioned-table, or the composite FK, so
// this declaration exists for query typing only — do not `drizzle-kit push` it.
//
// `customer_bill_line` IS the bill's charge record (Module Inv. #3 — the §0
// reversal of the old "no billing-side charge table" rule), holding disaggregated
// charge lines at the (product_offering_id, udr_type) grain: one row per
// aggregated charge, whose three money columns (`gross_amount`, `discount_amount`,
// `net_amount`) roll up into `customer_bill.subtotal` (SUM(net_amount), enforced
// by aggregation in bm28, not a constraint here). `ref_product_offering_id`
// carries NO FK (the reserved plain-text-ref pattern, architecture §1). The FK
// to `customer_bill` is `ON DELETE CASCADE` (D22): the whole-account replace
// (bm28) deletes the trial header through `billrun_delete_trial_bill` and the
// lines vanish with it — never a per-line DELETE or upsert (Inv #16). There is
// NO row trigger (D27 — the header finalization guard already makes a finalized
// bill un-deletable) and NO business UNIQUE on (bill, offering, udr_type). The
// allowed `source`/`line_type`/`discount_type` values are authoritative in the
// migration's CHECKs; the shared `ChargeSource`/`LineType` unions land with the
// first consumer (bm28's `BillLineTable`).

export const customerBillLineSeq = billing.sequence("customer_bill_line_seq", {
  startWith: 1,
});

export const customerBillLine = billing.table("customer_bill_line", {
  customerBillLineId: text("customer_bill_line_id")
    .notNull()
    .default(
      sql`'BLN' || lpad(nextval('billing.customer_bill_line_seq')::text, 8, '0')`,
    ),
  refCustomerBillId: text("ref_customer_bill_id").notNull(),
  periodPartition: date("period_partition", { mode: "string" }).notNull(),
  lineNo: integer("line_no").notNull(),
  source: text("source").notNull(),
  lineType: text("line_type").notNull().default("charge"),
  // Plain-text ref, no cross-schema FK (architecture §1).
  refProductOfferingId: text("ref_product_offering_id").notNull(),
  udrType: text("udr_type"), // USAGE only; NULL for RECURRING
  description: text("description"),
  quantity: numeric("quantity", { mode: "string", precision: 20, scale: 6 }),
  unit: text("unit"),
  grossAmount: numeric("gross_amount", {
    mode: "string",
    precision: 18,
    scale: 2,
  }).notNull(),
  discountAmount: numeric("discount_amount", {
    mode: "string",
    precision: 18,
    scale: 2,
  })
    .notNull()
    .default("0.00"),
  netAmount: numeric("net_amount", {
    mode: "string",
    precision: 18,
    scale: 2,
  }).notNull(),
  // udr_rated-shaped (0034): 'fixed'|'percentage'.
  discountType: text("discount_type"),
  discountRate: numeric("discount_rate", {
    mode: "string",
    precision: 18,
    scale: 6,
  }),
  discountAmountRaw: numeric("discount_amount_raw", {
    mode: "string",
    precision: 18,
    scale: 6,
  }),
  // USAGE: count of udr_rated rows rolled into this line.
  udrCount: integer("udr_count"),
  // Deterministic line_no ordering + reconciliation replay (bm30).
  groupingKey: text("grouping_key").notNull(),
  currency: char("currency", { length: 3 }).notNull(),
  // RECURRING price snapshot (D19), NULL for USAGE.
  snapshotPriceRef: text("snapshot_price_ref"),
  snapshotUnitPrice: numeric("snapshot_unit_price", {
    mode: "string",
    precision: 18,
    scale: 6,
  }),
  snapshotQuantity: numeric("snapshot_quantity", {
    mode: "string",
    precision: 20,
    scale: 6,
  }),
  snapshotEffectiveDate: date("snapshot_effective_date", { mode: "string" }),
});

export type CustomerBillLine = typeof customerBillLine.$inferSelect;
export type CustomerBillLineInsert = typeof customerBillLine.$inferInsert;
