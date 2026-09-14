-- bm23-spec §Implementation §1. billing.customer_bill_line — the bill's charge
-- record at (product_offering_id, udr_type) grain (Inv #3). PARTITION BY RANGE
-- (period_partition) via pg_partman (billing-partman-setup.sql), same pattern as
-- customer_bill (0029). Composite FK to customer_bill ON DELETE CASCADE (D22) so
-- the whole-account replace (bm28) removes lines with the header. NO row trigger
-- (D27) and NO business UNIQUE on (bill, offering, udr_type) — exactly-once is the
-- whole-account replace, not a constraint (Inv #16).
CREATE SEQUENCE "billing"."customer_bill_line_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;
--> statement-breakpoint
CREATE TABLE "billing"."customer_bill_line" (
  "customer_bill_line_id" text DEFAULT 'BLN' || lpad(nextval('billing.customer_bill_line_seq')::text, 8, '0') NOT NULL,
  "ref_customer_bill_id"  text NOT NULL,
  "period_partition"      date NOT NULL,
  "line_no"               integer NOT NULL,
  "source"                text NOT NULL,
  "line_type"             text NOT NULL DEFAULT 'charge',
  "ref_product_offering_id" text NOT NULL,     -- plain-text ref, no cross-schema FK (architecture §1)
  "udr_type"              text,                 -- USAGE only; NULL for RECURRING
  "description"           text,
  "quantity"              numeric(20, 6),
  "unit"                  text,
  "gross_amount"          numeric(18, 2) NOT NULL,
  "discount_amount"       numeric(18, 2) NOT NULL DEFAULT '0.00',
  "net_amount"            numeric(18, 2) NOT NULL,
  "discount_type"         text,                 -- udr_rated-shaped (0034): 'fixed'|'percentage'
  "discount_rate"         numeric(18, 6),
  "discount_amount_raw"   numeric(18, 6),
  "udr_count"             integer,              -- USAGE: count of udr_rated rows rolled into this line
  "grouping_key"          text NOT NULL,        -- deterministic line_no ordering + reconciliation replay (bm30)
  "currency"              char(3) NOT NULL,
  "snapshot_price_ref"        text,             -- RECURRING price snapshot (D19), NULL for USAGE
  "snapshot_unit_price"       numeric(18, 6),
  "snapshot_quantity"         numeric(20, 6),
  "snapshot_effective_date"   date,
  CONSTRAINT "customer_bill_line_pk" PRIMARY KEY ("customer_bill_line_id","period_partition"),
  CONSTRAINT "customer_bill_line_customer_bill_fk"
    FOREIGN KEY ("ref_customer_bill_id","period_partition")
    REFERENCES "billing"."customer_bill" ("customer_bill_id","period_partition") ON DELETE CASCADE,
  CONSTRAINT "customer_bill_line_source_check"    CHECK (source IN ('USAGE','RECURRING','OCC')),
  CONSTRAINT "customer_bill_line_line_type_check" CHECK (line_type IN ('charge','discount','adjustment')),
  CONSTRAINT "customer_bill_line_discount_type_check" CHECK (discount_type IS NULL OR discount_type IN ('fixed','percentage'))
) PARTITION BY RANGE ("period_partition");
--> statement-breakpoint
-- Index the FK child columns (customer_bill_tax_item/0030 precedent). Postgres
-- does NOT auto-index the referencing side of a foreign key, so the composite
-- ON DELETE CASCADE FK to customer_bill needs this index or the whole-account
-- replace (bm28: DELETE customer_bill -> cascade) seq-scans every partition to
-- find child lines on the hot re-derivation path (Inv #16, D22). period_partition
-- is indexed too, matching 0029/0030.
CREATE INDEX "customer_bill_line_ref_customer_bill_id_idx" ON "billing"."customer_bill_line" USING btree ("ref_customer_bill_id");
--> statement-breakpoint
CREATE INDEX "customer_bill_line_period_partition_idx" ON "billing"."customer_bill_line" USING btree ("period_partition");
--> statement-breakpoint
CREATE TABLE "billing"."customer_bill_line_default" PARTITION OF "billing"."customer_bill_line" DEFAULT;
