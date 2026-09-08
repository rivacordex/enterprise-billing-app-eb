-- bm19-spec §Phase-2 review folds (2026-08-28) T5 [P1] — "structural
-- one-INV-per-bill latch (closes known-issue #2)". "At most one posted INV
-- per (run, account)" was enforced only by app-layer lock discipline
-- (`customerBillRepository.lockBillForPosting`'s `FOR UPDATE` + `stampPosted`'s
-- `ref_inv_document_id IS NULL` guard, bm11-spec §Design). This adds the
-- schema-level backstop: `ref_customer_bill_id`/`period_partition` (nullable
-- — only ever populated for the one `INV` a posted bill's document carries;
-- every other `doc_type` leaves both NULL) plus a partial UNIQUE index keyed
-- on `ref_customer_bill_id` — structurally, no more than one `document` row
-- can EVER reference a given `customer_bill`, so a duplicate posted INV
-- cannot be created regardless of what the app-layer checks do.
ALTER TABLE "billing"."document" ADD COLUMN "ref_customer_bill_id" text;--> statement-breakpoint
ALTER TABLE "billing"."document" ADD COLUMN "period_partition" date;--> statement-breakpoint
ALTER TABLE "billing"."document" ADD CONSTRAINT "document_customer_bill_fk" FOREIGN KEY ("ref_customer_bill_id","period_partition") REFERENCES "billing"."customer_bill"("customer_bill_id","period_partition") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Composite FKs default to MATCH SIMPLE, which skips the FK check when ANY
-- referenced column is NULL: a half-set (one value, one NULL) pair would bypass
-- the FK above and dangle. Require both-or-neither, and confine a non-NULL pair
-- to INV documents (the only doc_type the latch applies to).
ALTER TABLE "billing"."document" ADD CONSTRAINT "document_customer_bill_ref_paired_check" CHECK (("ref_customer_bill_id" IS NULL) = ("period_partition" IS NULL));--> statement-breakpoint
ALTER TABLE "billing"."document" ADD CONSTRAINT "document_customer_bill_ref_inv_only_check" CHECK ("ref_customer_bill_id" IS NULL OR "doc_type" = 'INV');--> statement-breakpoint
CREATE UNIQUE INDEX "document_ref_customer_bill_id_unique" ON "billing"."document" USING btree ("ref_customer_bill_id") WHERE "ref_customer_bill_id" IS NOT NULL;
