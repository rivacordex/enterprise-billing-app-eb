-- bm16-spec §Design "Two executions, named columns (D23)" / §Implementation
-- §2. `bill_run` is not partitioned (architecture §3), so this is a plain
-- ALTER TABLE — hand-authored (Drizzle can't express the RENAME COLUMN this
-- unit needs alongside new columns in one migration, matching the 0001_audit
-- precedent every other hand-authored migration in this module follows).
--
-- Renames Phase 1's singular workflow_* columns to the processing_* set (the
-- run's ONE bill_run_processing execution) and adds the distribution_* set
-- (a second, independent execution — bm20 populates it; this unit only
-- creates the columns) plus processing_engine_ref/distribution_engine_ref —
-- the resolved engine identity stamped per execution (D25e) so a later
-- topology change (one shared engine instance vs. two) never orphans
-- reconcile/cancel of a historical execution.
ALTER TABLE "billing"."bill_run" RENAME COLUMN "workflow_execution_id" TO "processing_execution_id";--> statement-breakpoint
ALTER TABLE "billing"."bill_run" RENAME COLUMN "workflow_definition_id" TO "processing_flow_id";--> statement-breakpoint
ALTER TABLE "billing"."bill_run" RENAME COLUMN "workflow_definition_revision" TO "processing_flow_revision";--> statement-breakpoint
ALTER TABLE "billing"."bill_run" ADD COLUMN "processing_engine_ref" text;--> statement-breakpoint
ALTER TABLE "billing"."bill_run" ADD COLUMN "distribution_execution_id" text;--> statement-breakpoint
ALTER TABLE "billing"."bill_run" ADD COLUMN "distribution_flow_id" text;--> statement-breakpoint
ALTER TABLE "billing"."bill_run" ADD COLUMN "distribution_flow_revision" integer;--> statement-breakpoint
ALTER TABLE "billing"."bill_run" ADD COLUMN "distribution_engine_ref" text;
