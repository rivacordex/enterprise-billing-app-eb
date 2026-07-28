-- Validate constraints added NOT VALID in 0014 in a separate transaction so
-- the ACCESS EXCLUSIVE lock from ADD CONSTRAINT is released before these
-- SHARE UPDATE EXCLUSIVE locks are acquired.
ALTER TABLE "billing"."billing_account" VALIDATE CONSTRAINT "billing_account_credit_limit_amount_check";--> statement-breakpoint
ALTER TABLE "billing"."financial_account" VALIDATE CONSTRAINT "financial_account_credit_limit_amount_check";--> statement-breakpoint
ALTER TABLE "billing"."reason_code" VALIDATE CONSTRAINT "reason_code_auto_post_limit_check";--> statement-breakpoint
ALTER TABLE "billing"."accounting_period" VALIDATE CONSTRAINT "accounting_period_period_format_check";
