CREATE SEQUENCE "billing"."bill_run_account_stage_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "billing"."bill_run_account_stage" (
	"bill_run_account_stage_id" text DEFAULT 'BRS' || lpad(nextval('billing.bill_run_account_stage_seq')::text, 8, '0') NOT NULL,
	"ref_bill_run_id" text NOT NULL,
	"ref_billing_account_id" text NOT NULL,
	"period_partition" date NOT NULL,
	"stage" text NOT NULL,
	"attempt" integer NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp (3) with time zone,
	"ended_at" timestamp (3) with time zone,
	"error_class" text,
	"error_code" text,
	"error_detail" text,
	CONSTRAINT "bill_run_account_stage_bill_run_account_stage_id_period_partition_pk" PRIMARY KEY("bill_run_account_stage_id","period_partition"),
	CONSTRAINT "bill_run_account_stage_run_ban_stage_attempt_period_unique" UNIQUE("ref_bill_run_id","ref_billing_account_id","stage","attempt","period_partition"),
	CONSTRAINT "bill_run_account_stage_stage_check" CHECK (stage IN ('scoping','validation','collection','aggregation','taxation','verification','posting','rendering','distribution')),
	CONSTRAINT "bill_run_account_stage_status_check" CHECK (status IN ('PENDING','RUNNING','DONE','FAILED','SKIPPED')),
	CONSTRAINT "bill_run_account_stage_error_class_check" CHECK (error_class IS NULL OR error_class IN ('HARD','SOFT','INFRA'))
) PARTITION BY RANGE ("period_partition");
--> statement-breakpoint
ALTER TABLE "billing"."bill_run_account_stage" ADD CONSTRAINT "bill_run_account_stage_ref_bill_run_id_bill_run_bill_run_id_fk" FOREIGN KEY ("ref_bill_run_id") REFERENCES "billing"."bill_run"("bill_run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."bill_run_account_stage" ADD CONSTRAINT "bill_run_account_stage_ref_billing_account_id_billing_account_billing_account_id_fk" FOREIGN KEY ("ref_billing_account_id") REFERENCES "billing"."billing_account"("billing_account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bill_run_account_stage_ref_bill_run_id_idx" ON "billing"."bill_run_account_stage" USING btree ("ref_bill_run_id");--> statement-breakpoint
CREATE INDEX "bill_run_account_stage_period_partition_idx" ON "billing"."bill_run_account_stage" USING btree ("period_partition");--> statement-breakpoint

-- Minimum-one bootstrap partition so the parent is valid before pg_partman
-- takes over (bill_run_account/audit_log precedent, 0027_bill_run_account.sql).
-- pg_partman's create_parent + run_maintenance_proc
-- (db/bootstrap/billing-partman-setup.sql, run once per environment) then
-- materialise the premake/forward partitions.
CREATE TABLE "billing"."bill_run_account_stage_default" PARTITION OF "billing"."bill_run_account_stage" DEFAULT;
