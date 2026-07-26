-- Review follow-up on ac02 (db/schema/billing/catalogs.ts): a plain UNIQUE
-- treats two NULL `currency` values as distinct, so two `(selector_type,
-- selector)` rows both carrying a NULL (all-currencies) currency could
-- coexist -- an ambiguous role mapping the seed/health check (ac03, Inv.
-- #10) never intended to allow. NULLS NOT DISTINCT closes that gap while
-- leaving distinct-currency rows for the same selector unaffected.
ALTER TABLE "billing"."gl_mapping" DROP CONSTRAINT "gl_mapping_selector_type_selector_currency_unique";--> statement-breakpoint
ALTER TABLE "billing"."gl_mapping" ADD CONSTRAINT "gl_mapping_selector_type_selector_currency_unique" UNIQUE NULLS NOT DISTINCT("selector_type","selector","currency");