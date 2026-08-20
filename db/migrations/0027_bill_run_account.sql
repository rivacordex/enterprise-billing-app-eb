CREATE SEQUENCE "billing"."bill_run_account_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "billing"."bill_run_account" (
	"bill_run_account_id" text DEFAULT 'BRA' || lpad(nextval('billing.bill_run_account_seq')::text, 8, '0') NOT NULL,
	"ref_bill_run_id" text NOT NULL,
	"ref_billing_account_id" text NOT NULL,
	"period_partition" date NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempt_count" integer DEFAULT 1 NOT NULL,
	"error_code" text,
	"error_detail" text,
	"last_processed_at" timestamp (3) with time zone,
	CONSTRAINT "bill_run_account_bill_run_account_id_period_partition_pk" PRIMARY KEY("bill_run_account_id","period_partition"),
	CONSTRAINT "bill_run_account_run_ban_period_unique" UNIQUE("ref_bill_run_id","ref_billing_account_id","period_partition"),
	CONSTRAINT "bill_run_account_status_check" CHECK (status IN ('PENDING','PROCESSING','PROCESSED','INVOICED','DISTRIBUTING','COMPLETED','PROCESSING_FAILED','DISTRIBUTION_FAILED','SKIPPED','EXCLUDED'))
) PARTITION BY RANGE ("period_partition");
--> statement-breakpoint
ALTER TABLE "billing"."bill_run_account" ADD CONSTRAINT "bill_run_account_ref_bill_run_id_bill_run_bill_run_id_fk" FOREIGN KEY ("ref_bill_run_id") REFERENCES "billing"."bill_run"("bill_run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."bill_run_account" ADD CONSTRAINT "bill_run_account_ref_billing_account_id_billing_account_billing_account_id_fk" FOREIGN KEY ("ref_billing_account_id") REFERENCES "billing"."billing_account"("billing_account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bill_run_account_ref_bill_run_id_idx" ON "billing"."bill_run_account" USING btree ("ref_bill_run_id");--> statement-breakpoint
CREATE INDEX "bill_run_account_period_partition_idx" ON "billing"."bill_run_account" USING btree ("period_partition");--> statement-breakpoint

-- Minimum-one bootstrap partition so the parent is valid before pg_partman
-- takes over (audit_log precedent, db/migrations/0001_audit.sql). pg_partman's
-- create_parent + run_maintenance_proc (db/bootstrap/billing-partman-setup.sql,
-- run once per environment) then materialise the premake/forward partitions.
CREATE TABLE "billing"."bill_run_account_default" PARTITION OF "billing"."bill_run_account" DEFAULT;
