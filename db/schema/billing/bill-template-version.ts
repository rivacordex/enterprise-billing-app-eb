import { boolean, integer, jsonb, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { billing } from "@/db/schema/billing/pg-schema";
import { billFormat } from "@/db/schema/billing/bill-format";
import { appuser } from "@/db/schema/identity";
import type {
  InvoiceTemplateStructure,
  LayoutPageSetup,
} from "@/types/billing";

// bm50-spec §Design D1. PHYSICAL DDL OF RECORD:
// db/migrations/0046_invoice_template_catalog.sql. Query typing only — not
// drizzle-kit pushed (the partial unique indexes, the CHECK family and the
// version-rules trigger `bill_template_version_guard` live in the migration).
// Immutable/append-only (Inv #44): rows only ever go DRAFT → ACTIVE → RETIRED,
// never deleted. `ref_layout_version_id` self-references this table in the
// migration; the FK is omitted here (plain text) to avoid a circular Drizzle
// reference — typing is unaffected.
export const billTemplateVersionSeq = billing.sequence(
  "bill_template_version_seq",
  { startWith: 1 },
);

export const billTemplateVersion = billing.table("bill_template_version", {
  billTemplateVersionId: text("bill_template_version_id")
    .primaryKey()
    .default(
      sql`'BTV' || lpad(nextval('billing.bill_template_version_seq')::text, 8, '0')`,
    ),
  refBillFormatId: text("ref_bill_format_id")
    .notNull()
    .references(() => billFormat.billFormatId),
  kind: text("kind").notNull(),
  versionNo: integer("version_no").notNull(),
  status: text("status").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  layoutCode: text("layout_code"),
  refLayoutVersionId: text("ref_layout_version_id"),
  structure: jsonb("structure").$type<InvoiceTemplateStructure>(),
  pageSetup: jsonb("page_setup").$type<LayoutPageSetup>(),
  blobRef: text("blob_ref"),
  checksum: text("checksum"),
  checksumAlgorithm: text("checksum_algorithm"),
  changeNote: text("change_note"),
  createdBy: text("created_by").references(() => appuser.id, {
    onDelete: "set null",
  }),
  createdDatetime: timestamp("created_datetime", {
    withTimezone: true,
    mode: "date",
  })
    .notNull()
    .default(sql`now()`),
  activatedBy: text("activated_by").references(() => appuser.id, {
    onDelete: "set null",
  }),
  activatedDatetime: timestamp("activated_datetime", {
    withTimezone: true,
    mode: "date",
  }),
  retiredDatetime: timestamp("retired_datetime", {
    withTimezone: true,
    mode: "date",
  }),
  lastModifiedDatetime: timestamp("last_modified_datetime", {
    withTimezone: true,
    mode: "date",
  })
    .notNull()
    .default(sql`now()`),
});

export type BillTemplateVersion = typeof billTemplateVersion.$inferSelect;
export type BillTemplateVersionInsert = typeof billTemplateVersion.$inferInsert;
