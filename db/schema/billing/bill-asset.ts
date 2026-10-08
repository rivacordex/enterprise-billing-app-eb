import { integer, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { billing } from "@/db/schema/billing/pg-schema";
import { appuser } from "@/db/schema/identity";

// bm50-spec §Design D1. PHYSICAL DDL OF RECORD:
// db/migrations/0046_invoice_template_catalog.sql. Query typing only — not
// drizzle-kit pushed. `bill_asset` holds the logo artifact; `bill_asset_version`
// its immutable versions (retire-only — `bill_asset_version_guard` allows only
// ACTIVE → RETIRED; neither table is deletable). No DRAFT status: an uploaded
// logo is a finished artifact; the "draft" is the profile that points at it.
export const billAssetSeq = billing.sequence("bill_asset_seq", {
  startWith: 1,
});

export const billAsset = billing.table("bill_asset", {
  billAssetId: text("bill_asset_id")
    .primaryKey()
    .default(
      sql`'INVAST' || lpad(nextval('billing.bill_asset_seq')::text, 8, '0')`,
    ),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  createdBy: text("created_by").references(() => appuser.id, {
    onDelete: "set null",
  }),
  createdDatetime: timestamp("created_datetime", {
    withTimezone: true,
    mode: "date",
  })
    .notNull()
    .default(sql`now()`),
});

export const billAssetVersionSeq = billing.sequence("bill_asset_version_seq", {
  startWith: 1,
});

export const billAssetVersion = billing.table("bill_asset_version", {
  billAssetVersionId: text("bill_asset_version_id")
    .primaryKey()
    .default(
      sql`'INVASV' || lpad(nextval('billing.bill_asset_version_seq')::text, 8, '0')`,
    ),
  refBillAssetId: text("ref_bill_asset_id")
    .notNull()
    .references(() => billAsset.billAssetId),
  versionNo: integer("version_no").notNull(),
  status: text("status").notNull().default("ACTIVE"),
  mime: text("mime").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  byteSize: integer("byte_size").notNull(),
  blobRef: text("blob_ref").notNull(),
  checksum: text("checksum").notNull(),
  checksumAlgorithm: text("checksum_algorithm").notNull(),
  createdBy: text("created_by").references(() => appuser.id, {
    onDelete: "set null",
  }),
  createdDatetime: timestamp("created_datetime", {
    withTimezone: true,
    mode: "date",
  })
    .notNull()
    .default(sql`now()`),
  retiredDatetime: timestamp("retired_datetime", {
    withTimezone: true,
    mode: "date",
  }),
});

export type BillAsset = typeof billAsset.$inferSelect;
export type BillAssetInsert = typeof billAsset.$inferInsert;
export type BillAssetVersion = typeof billAssetVersion.$inferSelect;
export type BillAssetVersionInsert = typeof billAssetVersion.$inferInsert;
