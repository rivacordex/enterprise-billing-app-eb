-- bm88 — Retire the bm62 invoice CSV and its CSV template machinery (owner decision
-- 2026-10-29, option B: "not the intended CSV format invoice"; the intended invoice CSV is the
-- reporting extract R<MNO><YYYYMMDD>.csv). Runs on a populated database. The PDF path is not
-- touched: no PDF read uses either stamp column or the csv kind.
--
-- IRREVERSIBLE: dropping the two stamp columns discards the CSV version recorded on every
-- run account and posted bill (accepted by the owner when choosing option B).

-- 1. The customer_bill CSV stamp index (0048).
DROP INDEX "billing"."customer_bill_ref_csv_template_version_id_idx";
--> statement-breakpoint

-- 2–3. The CSV stamp columns (0046, 0051). Plain-key columns, no FK; no GRANT lists them.
ALTER TABLE "billing"."customer_bill" DROP COLUMN "ref_csv_template_version_id";
--> statement-breakpoint
ALTER TABLE "billing"."bill_run_account" DROP COLUMN "ref_csv_template_version_id";
--> statement-breakpoint

-- 4. The CSV-only indexes and CHECKs on bill_template_version (0053 §6, §8).
DROP INDEX "billing"."btv_version_csv_uq";
--> statement-breakpoint
DROP INDEX "billing"."btv_one_active_uq";
--> statement-breakpoint
ALTER TABLE "billing"."bill_template_version"
  DROP CONSTRAINT "btv_csv_has_no_family",
  DROP CONSTRAINT "btv_draft_not_csv",
  DROP CONSTRAINT "btv_type_scoped_has_family";
--> statement-breakpoint

-- 5. Delete the csv version rows (BTV00000003 and any later csv version). The guard forbids
--    every DELETE, so it is disabled for this one statement only and re-enabled; the stamp
--    columns that pointed at these rows are already gone (steps 2–3). This is the one-time
--    exception to "version rows are never deleted". One DO block = one rollback unit.
DO $$
BEGIN
  ALTER TABLE "billing"."bill_template_version" DISABLE TRIGGER "bill_template_version_guard_trg";
  DELETE FROM "billing"."bill_template_version" WHERE "kind" = 'csv';
  ALTER TABLE "billing"."bill_template_version" ENABLE TRIGGER "bill_template_version_guard_trg";
END $$;
--> statement-breakpoint

-- 6. The kind check shrinks to the type-scoped kinds, and every row now needs a type.
--    bill_template_version_kind_check is 0046's inline column CHECK (generated name).
ALTER TABLE "billing"."bill_template_version"
  DROP CONSTRAINT "bill_template_version_kind_check";
--> statement-breakpoint
ALTER TABLE "billing"."bill_template_version"
  ADD CONSTRAINT "btv_kind_check" CHECK ("kind" IN ('layout','generated')),
  ADD CONSTRAINT "btv_has_family" CHECK ("ref_bill_template_family_id" IS NOT NULL);
