-- bm20-spec §Implementation §1 T1. `bill_run` gains one plain column (not
-- partitioned, architecture §3) — the current distribution round, mirroring
-- `bill_run_account.attempt_count`. Hand-authored ALTER TABLE, same shape as
-- 0035_bill_run_two_executions.sql.
ALTER TABLE "billing"."bill_run" ADD COLUMN "distribution_attempt" integer;--> statement-breakpoint

-- bm20-spec §Implementation §1. The new partitioned delivery-log/idempotency
-- table — hand-authored (Drizzle can't express PARTITION BY), following the
-- `bill_run_invoices` (0036) pattern exactly: composite PK on
-- (bill_run_distribution_id, period_partition), a bootstrap DEFAULT partition
-- so the parent is valid before pg_partman takes over
-- (db/bootstrap/billing-partman-setup.sql, run once per environment).
CREATE SEQUENCE "billing"."bill_run_distribution_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "billing"."bill_run_distribution" (
	"bill_run_distribution_id" text DEFAULT 'BRD' || lpad(nextval('billing.bill_run_distribution_seq')::text, 8, '0') NOT NULL,
	"ref_bill_run_id" text NOT NULL,
	"target" text NOT NULL,
	"artifact_ref" text NOT NULL,
	"artifact_type" text NOT NULL,
	"is_mandatory" boolean NOT NULL,
	"outcome" text NOT NULL,
	"at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"distribution_attempt" integer NOT NULL,
	"period_partition" date NOT NULL,
	CONSTRAINT "bill_run_distribution_bill_run_distribution_id_period_partition_pk" PRIMARY KEY("bill_run_distribution_id","period_partition"),
	CONSTRAINT "bill_run_distribution_run_target_artifact_attempt_period_unique" UNIQUE("ref_bill_run_id","target","artifact_ref","distribution_attempt","period_partition"),
	CONSTRAINT "bill_run_distribution_artifact_type_check" CHECK (artifact_type IN ('invoice_pdf','report_csv')),
	CONSTRAINT "bill_run_distribution_outcome_check" CHECK (outcome IN ('DELIVERED','FAILED'))
) PARTITION BY RANGE ("period_partition");
--> statement-breakpoint
ALTER TABLE "billing"."bill_run_distribution" ADD CONSTRAINT "bill_run_distribution_ref_bill_run_id_bill_run_bill_run_id_fk" FOREIGN KEY ("ref_bill_run_id") REFERENCES "billing"."bill_run"("bill_run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bill_run_distribution_ref_bill_run_id_idx" ON "billing"."bill_run_distribution" USING btree ("ref_bill_run_id");--> statement-breakpoint
CREATE INDEX "bill_run_distribution_period_partition_idx" ON "billing"."bill_run_distribution" USING btree ("period_partition");--> statement-breakpoint

-- Minimum-one bootstrap partition so the parent is valid before pg_partman
-- takes over (bill_run_invoices precedent, 0036). pg_partman's create_parent
-- + run_maintenance_proc (db/bootstrap/billing-partman-setup.sql, run once
-- per environment) then materialise the premake/forward partitions.
CREATE TABLE "billing"."bill_run_distribution_default" PARTITION OF "billing"."bill_run_distribution" DEFAULT;
