-- Standardize human-readable domain-table IDs on an 8-digit zero-padded suffix.
-- Nine tables were seeded at 6 or 7 digits (`architecture.md` §3 / code-standards
-- #18 said "zero-padded" but never pinned the width); this aligns them with the
-- four entities already at 8 (party_role, contact_medium, document_line, document),
-- so no new precedent — just consistency. Prevents the silent ID-widening + lexical
-- sort inversion that happens when a narrower sequence rolls past its pad width.
--
-- Hand-authored, not drizzle-kit generated: this is purely a DEFAULT-expression
-- change. `ALTER COLUMN ... SET DEFAULT` only affects future INSERTs without an
-- explicit id; it touches no existing row and takes no lock beyond the catalog
-- update. Columns stay `text`, sequences stay BIGINT. Existing (pre-migration)
-- rows keep their narrower ids exactly as stored — a `text` PK needs no fixed width.
ALTER TABLE "product"."product_offering" ALTER COLUMN "product_offering_id" SET DEFAULT 'PRDOFR' || lpad(nextval('product.product_offering_seq')::text, 8, '0');
ALTER TABLE "product"."product_offering_price" ALTER COLUMN "product_offering_price_id" SET DEFAULT 'PRDOFP' || lpad(nextval('product.product_offering_price_seq')::text, 8, '0');
ALTER TABLE "product"."product_specifications" ALTER COLUMN "product_spec_id" SET DEFAULT 'PRDSMD' || lpad(nextval('product.product_specifications_seq')::text, 8, '0');
ALTER TABLE "customer"."organization" ALTER COLUMN "organization_id" SET DEFAULT 'ORG' || lpad(nextval('customer.organization_seq')::text, 8, '0');
ALTER TABLE "billing"."financial_account" ALTER COLUMN "financial_account_id" SET DEFAULT 'FIN' || lpad(nextval('billing.financial_account_seq')::text, 8, '0');
ALTER TABLE "billing"."billing_account" ALTER COLUMN "billing_account_id" SET DEFAULT 'BAN' || lpad(nextval('billing.billing_account_seq')::text, 8, '0');
ALTER TABLE "billing"."bill_cycle" ALTER COLUMN "bill_cycle_id" SET DEFAULT 'BCY' || lpad(nextval('billing.bill_cycle_seq')::text, 8, '0');
ALTER TABLE "billing"."gl_mapping" ALTER COLUMN "gl_mapping_id" SET DEFAULT 'GLM' || lpad(nextval('billing.gl_mapping_seq')::text, 8, '0');
ALTER TABLE "billing"."ledger_binding" ALTER COLUMN "ledger_binding_id" SET DEFAULT 'LBD' || lpad(nextval('billing.ledger_binding_seq')::text, 8, '0');
