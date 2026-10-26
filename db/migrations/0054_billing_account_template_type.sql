-- cm23 (Inv. #19) — a BAN's invoice template becomes a TYPE reference (NULL = Standard).
-- Ships in one merge with Billing bm82, whose capture read (listBanFamilies) moves to
-- this column in the same change. 0050 is not edited. No backfill: v1 allowed only NULL.
ALTER TABLE "billing"."billing_account"
  ADD COLUMN "ref_bill_template_family_id" text;
--> statement-breakpoint
ALTER TABLE "billing"."billing_account"
  ADD CONSTRAINT "billing_account_ref_bill_template_family_id_fk"
  FOREIGN KEY ("ref_bill_template_family_id")
  REFERENCES "billing"."bill_template_family"("bill_template_family_id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
COMMENT ON COLUMN "billing"."billing_account"."ref_bill_template_family_id" IS
  'Invoice template type for this BAN. NULL = Standard (the default type); Standard is stored only as NULL. Written by setBillingAccountTemplate (via assertBindableTemplate), onboarding (always NULL) and Billing''s retire switch. Read by the bill run at capture (cm23/bm82).';
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "billing"."billing_account" WHERE "ref_bill_template_version_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'MIGRATION_PRECONDITION: billing_account.ref_bill_template_version_id is non-NULL on % row(s); v1 allowed NULL only.',
      (SELECT count(*) FROM "billing"."billing_account" WHERE "ref_bill_template_version_id" IS NOT NULL);
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "billing"."billing_account" DROP CONSTRAINT "billing_account_ref_bill_template_version_id_fk";
--> statement-breakpoint
ALTER TABLE "billing"."billing_account" DROP COLUMN "ref_bill_template_version_id";
