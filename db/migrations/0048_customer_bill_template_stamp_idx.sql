-- bm55 review: partial indexes on the posting-time template stamps so
-- `billTemplateVersionRepository.listForKind`'s used-by counts (an OR over the
-- two columns) no longer scan every customer_bill partition. Created on the
-- partitioned parent (propagates to existing and future pg_partman children);
-- partial because the stamps are NULL on every unposted/pre-bm54 bill.
-- Forward-only; no grant change.
-- Locking: plain (non-CONCURRENTLY) CREATE INDEX takes a SHARE lock on the parent
-- and every partition for the duration of the build, blocking writes (posting,
-- aggregation) but not reads. CONCURRENTLY is not possible on a partitioned
-- parent or inside the migrator's transaction. Acceptable while customer_bill is
-- small; on a large prod table run it in a maintenance window with no bill run
-- in PROCESSING/APPROVING.
CREATE INDEX IF NOT EXISTS "customer_bill_ref_bill_template_version_id_idx" ON "billing"."customer_bill" USING btree ("ref_bill_template_version_id") WHERE "ref_bill_template_version_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_bill_ref_csv_template_version_id_idx" ON "billing"."customer_bill" USING btree ("ref_csv_template_version_id") WHERE "ref_csv_template_version_id" IS NOT NULL;
