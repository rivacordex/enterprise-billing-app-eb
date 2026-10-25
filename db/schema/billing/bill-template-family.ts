import { boolean, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { billing } from "@/db/schema/billing/pg-schema";
import { appuser } from "@/db/schema/identity";

// bm64-spec §Design. PHYSICAL DDL OF RECORD:
// db/migrations/0046_invoice_template_catalog.sql, amended by
// 0053_invoice_template_types.sql. Query typing only — not drizzle-kit pushed
// (`btf_code_uq`, `btf_one_default_uq`, the CHECKs and the
// `bill_template_family_guard` trigger live in the migrations). One row per
// invoice template type; the seeded row is Standard (`BTF00000001`, the
// default), whose layout code is `INVTPL-STD-A4`. No status column (D44): a
// type is usable when `retired_datetime IS NULL` and it has an ACTIVE
// `generated` version. `code`, `name`, `layout_code` and `kind` are immutable;
// rows are never deleted. bm74 (`0053`): `layout_code` is unique
// (`btf_layout_code_uq`) and frozen with `name` and `code`; the code / layout
// code / name format CHECKs and the case- and space-insensitive name index
// `btf_name_ci_uq` live in `0053`.
export const billTemplateFamilySeq = billing.sequence(
  "bill_template_family_seq",
  { startWith: 1 },
);

export const billTemplateFamily = billing.table("bill_template_family", {
  billTemplateFamilyId: text("bill_template_family_id")
    .primaryKey()
    .default(
      sql`'BTF' || lpad(nextval('billing.bill_template_family_seq')::text, 8, '0')`,
    ),
  code: text("code").notNull(),
  name: text("name").notNull(),
  layoutCode: text("layout_code").notNull(),
  kind: text("kind").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  retiredDatetime: timestamp("retired_datetime", {
    withTimezone: true,
    mode: "date",
  }),
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
