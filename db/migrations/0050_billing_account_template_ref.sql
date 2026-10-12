-- cm17 (Customer Management — Invoice Template Binding update). Adds the
-- per-BAN invoice template reference. NULL = follow the current ACTIVE
-- template, else the default (binding plan D9). Semantics are "follow the
-- template line", kind `generated` only (D10); v1 writes NULL only (D13) and
-- posting never reads this column (custmgmt Inv. #18). No backfill, no index,
-- no grant change (app_runtime already has table-level DML on billing_account).
ALTER TABLE "billing"."billing_account"
  ADD COLUMN IF NOT EXISTS "ref_bill_template_version_id" text;
--> statement-breakpoint
ALTER TABLE "billing"."billing_account"
  ADD CONSTRAINT "billing_account_ref_bill_template_version_id_fk"
  FOREIGN KEY ("ref_bill_template_version_id")
  REFERENCES "billing"."bill_template_version"("bill_template_version_id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
COMMENT ON COLUMN "billing"."billing_account"."ref_bill_template_version_id" IS
  'Invoice template for this BAN. NULL = follow the current ACTIVE template, else the default. Follow-the-line semantics, kind generated only. v1 accepts NULL only; posting does not read it (cm17).';
