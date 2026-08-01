-- Review follow-up on ac02/ac03: gl_mapping was missing the catalog-table
-- retirement invariant (code-standards §1.3) — all other catalog tables
-- (bill_cycle, reason_code, gl_account) already had a `state` column with an
-- `active | retired` CHECK. Add it to gl_mapping with the same definition and
-- default, using NOT VALID so existing rows are not scanned at migration time
-- (validated in a follow-up migration, same pattern as 0016).
ALTER TABLE "billing"."gl_mapping"
  ADD COLUMN "state" text NOT NULL DEFAULT 'active';
--> statement-breakpoint
ALTER TABLE "billing"."gl_mapping"
  ADD CONSTRAINT "gl_mapping_state_check"
  CHECK (state IN ('active','retired')) NOT VALID;
