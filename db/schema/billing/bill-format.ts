import { text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { billing } from "@/db/schema/billing/pg-schema";

// bm50-spec §Design D1. PHYSICAL DDL OF RECORD:
// db/migrations/0046_invoice_template_catalog.sql. Query typing only — not
// drizzle-kit pushed. Exactly one row (`INVOICE`); the CHECK pins the code
// (code-standards Part 2 TS rule 6). `customer_bill.ref_bill_format_id` is
// stamped with the literal `'INVOICE'`, so the format uses its code as its key
// (no sequence). DELETE/UPDATE are refused by `bill_format_forbid_trg`.
export const billFormat = billing.table("bill_format", {
  billFormatId: text("bill_format_id").primaryKey(),
  name: text("name").notNull(),
  createdDatetime: timestamp("created_datetime", {
    withTimezone: true,
    mode: "date",
  })
    .notNull()
    .default(sql`now()`),
});

export type BillFormat = typeof billFormat.$inferSelect;
export type BillFormatInsert = typeof billFormat.$inferInsert;
