-- bm55 review: partial index backing `customerBillRepository.listRecentPosted`
-- (WHERE ref_inv_document_id IS NOT NULL ORDER BY ref_inv_document_id DESC LIMIT n).
-- Created on the partitioned parent, so Postgres propagates it to every existing
-- and future pg_partman child. Partial: unposted trial bills (the bulk of rows
-- mid-run) are excluded. Forward-only; no grant change.
-- Locking: plain CREATE INDEX blocks writes to customer_bill for the build (see
-- 0048 for the full note); run outside an active bill run on a large table.
CREATE INDEX IF NOT EXISTS "customer_bill_posted_inv_document_idx" ON "billing"."customer_bill" USING btree ("ref_inv_document_id" DESC) WHERE "ref_inv_document_id" IS NOT NULL;
