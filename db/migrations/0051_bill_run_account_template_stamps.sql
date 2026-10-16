-- bm65 (Invoice Template Phase 3) — run-start template capture (D35, Inv #51/#52).
-- Five nullable stamp columns on the partitioned bill_run_account: the family,
-- generated version, invoice profile version and CSV version the BAN will be
-- invoiced with, and the capture time. Written only by captureTemplateStamps
-- (app_runtime) in the trigger/rerun transaction; NULL on EXCLUDED rows.
-- Plain keys, NO FK — the posting-stamp rule of 0029/0046 D6 on a partitioned
-- table; the catalog rows they point at are guard-protected from DELETE (bm50).
-- ALTER on the partitioned parent propagates to every pg_partman partition.
-- template_captured_at is timestamptz(3), like last_processed_at (Data rule 4;
-- corrected in place 2026-10-16 under D26's fresh-DB round, owner-approved).
ALTER TABLE "billing"."bill_run_account" ADD COLUMN "ref_bill_template_family_id" text;
--> statement-breakpoint
ALTER TABLE "billing"."bill_run_account" ADD COLUMN "ref_bill_template_version_id" text;
--> statement-breakpoint
ALTER TABLE "billing"."bill_run_account" ADD COLUMN "ref_invoice_profile_version" integer;
--> statement-breakpoint
ALTER TABLE "billing"."bill_run_account" ADD COLUMN "ref_csv_template_version_id" text;
--> statement-breakpoint
ALTER TABLE "billing"."bill_run_account" ADD COLUMN "template_captured_at" timestamptz(3);
