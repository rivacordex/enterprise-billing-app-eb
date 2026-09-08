import {
  date,
  foreignKey,
  index,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { billing } from "@/db/schema/billing/pg-schema";
import { billRun } from "@/db/schema/billing/bill-run";
import { billingAccount } from "@/db/schema/billing/accounts";
import { customerBill } from "@/db/schema/billing/customer-bill";
import { document } from "@/db/schema/billing/documents";

// bm19-spec §Implementation §1. PHYSICAL DDL OF RECORD:
// db/migrations/0036_bill_run_invoices.sql. PARTITION BY RANGE
// (period_partition) via pg_partman (db/bootstrap/billing-partman-setup.sql),
// following the `customer_bill`/`customer_bill_tax_item` pattern exactly:
// Drizzle cannot express partitioning or the composite-PK-on-partitioned-
// table, so this declaration exists for query typing only — do not
// `drizzle-kit push` it.
//
// One row per POSTED account per run — the issued, immutable final invoice
// artifact (blob + PDF checksum), written in a SEPARATE step AFTER the
// posting transaction commits (D10). A row, once written, is never
// UPDATEd/DELETEd (migration-level trigger, analogous to the
// `customer_bill_finalization_guard`, 0033) — unlike that guard this one is
// unconditional: there is no "unfinalized" state for this table, every row
// is born final. `billrun_runtime` gets no grant at all here (app-only,
// billrun-db-roles.sql Step 11 — no ALTER DEFAULT PRIVILEGES for it, so a
// newly created table carries no privilege for that role by construction).

export const billRunInvoiceSeq = billing.sequence("bill_run_invoice_seq", {
  startWith: 1,
});

export const billRunInvoices = billing.table(
  "bill_run_invoices",
  {
    billRunInvoiceId: text("bill_run_invoice_id")
      .notNull()
      .default(
        sql`'BRI' || lpad(nextval('billing.bill_run_invoice_seq')::text, 8, '0')`,
      ),
    refBillRunId: text("ref_bill_run_id")
      .notNull()
      .references(() => billRun.billRunId, { onDelete: "restrict" }),
    refBillingAccountId: text("ref_billing_account_id")
      .notNull()
      .references(() => billingAccount.billingAccountId, {
        onDelete: "restrict",
      }),
    refCustomerBillId: text("ref_customer_bill_id").notNull(),
    refInvDocumentId: text("ref_inv_document_id")
      .notNull()
      .references(() => document.documentId, { onDelete: "restrict" }),
    blobRef: text("blob_ref").notNull(),
    checksum: text("checksum").notNull(),
    renderedAt: timestamp("rendered_at", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
    periodPartition: date("period_partition", { mode: "string" }).notNull(),
  },
  (t) => [
    // Composite PK is required because period_partition is the partition key
    // (Postgres requires the partition key in every unique/PK on a
    // partitioned table).
    primaryKey({ columns: [t.billRunInvoiceId, t.periodPartition] }),
    // One final invoice per account per run (Implementation §1).
    unique("bill_run_invoices_run_ban_period_unique").on(
      t.refBillRunId,
      t.refBillingAccountId,
      t.periodPartition,
    ),
    // Composite FK to the (also-partitioned) `customer_bill`, keyed on its
    // full PK `(customer_bill_id, period_partition)` — the stored invoice can
    // never outlive or precede the bill it renders. RESTRICT (never CASCADE):
    // a posted bill is never deleted (Inv. #4), so this FK only guards against
    // an impossible ordering, not a real cascade path.
    foreignKey({
      columns: [t.refCustomerBillId, t.periodPartition],
      foreignColumns: [customerBill.customerBillId, customerBill.periodPartition],
      name: "bill_run_invoices_customer_bill_fk",
    }).onDelete("restrict"),
    index("bill_run_invoices_ref_bill_run_id_idx").on(t.refBillRunId),
    index("bill_run_invoices_period_partition_idx").on(t.periodPartition),
  ],
);

export type BillRunInvoice = typeof billRunInvoices.$inferSelect;
export type BillRunInvoiceInsert = typeof billRunInvoices.$inferInsert;
