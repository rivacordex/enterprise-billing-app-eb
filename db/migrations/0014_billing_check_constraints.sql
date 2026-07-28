-- Review follow-up on ac02: guard the module's monetary/period columns that
-- had no CHECK at all. credit_limit_amount stays nullable (no limit set) but
-- must be non-negative when present; auto_post_limit is already NOT NULL
-- default 0, just needed the >= 0 floor; accounting_period.period must match
-- the `to_char(event_at, 'YYYY-MM')` key gl_journal_view groups by
-- (db/schema/billing/views.ts).
ALTER TABLE "billing"."billing_account" ADD CONSTRAINT "billing_account_credit_limit_amount_check" CHECK (credit_limit_amount IS NULL OR credit_limit_amount >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "billing"."financial_account" ADD CONSTRAINT "financial_account_credit_limit_amount_check" CHECK (credit_limit_amount IS NULL OR credit_limit_amount >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "billing"."reason_code" ADD CONSTRAINT "reason_code_auto_post_limit_check" CHECK (auto_post_limit >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "billing"."accounting_period" ADD CONSTRAINT "accounting_period_period_format_check" CHECK (period ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])$') NOT VALID;