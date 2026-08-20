CREATE SEQUENCE "billing"."customer_bill_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "billing"."customer_bill" (
	"customer_bill_id" text DEFAULT 'CBL' || lpad(nextval('billing.customer_bill_seq')::text, 8, '0') NOT NULL,
	"ref_bill_run_id" text NOT NULL,
	"ref_billing_account_id" text NOT NULL,
	"period_partition" date NOT NULL,
	"category" text NOT NULL,
	"state" text DEFAULT 'new' NOT NULL,
	"billing_period_start" date NOT NULL,
	"billing_period_end" date NOT NULL,
	"subtotal" numeric(18, 2) NOT NULL,
	"tax_total" numeric(18, 2) NOT NULL,
	"total_amount" numeric(18, 2) NOT NULL,
	"payment_due_date" date NOT NULL,
	"ref_bill_format_id" text,
	"ref_bill_template_version_id" text,
	"ref_inv_document_id" text,
	"posted_attempt" integer,
	"charge_checksum" text,
	CONSTRAINT "customer_bill_customer_bill_id_period_partition_pk" PRIMARY KEY("customer_bill_id","period_partition"),
	CONSTRAINT "customer_bill_run_ban_period_unique" UNIQUE("ref_bill_run_id","ref_billing_account_id","period_partition"),
	CONSTRAINT "customer_bill_category_check" CHECK (category IN ('trial','normal','last')),
	CONSTRAINT "customer_bill_state_check" CHECK (state IN ('new','validated','sent'))
) PARTITION BY RANGE ("period_partition");
--> statement-breakpoint
ALTER TABLE "billing"."customer_bill" ADD CONSTRAINT "customer_bill_ref_bill_run_id_bill_run_bill_run_id_fk" FOREIGN KEY ("ref_bill_run_id") REFERENCES "billing"."bill_run"("bill_run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."customer_bill" ADD CONSTRAINT "customer_bill_ref_billing_account_id_billing_account_billing_account_id_fk" FOREIGN KEY ("ref_billing_account_id") REFERENCES "billing"."billing_account"("billing_account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_bill_ref_bill_run_id_idx" ON "billing"."customer_bill" USING btree ("ref_bill_run_id");--> statement-breakpoint
CREATE INDEX "customer_bill_period_partition_idx" ON "billing"."customer_bill" USING btree ("period_partition");--> statement-breakpoint

-- Minimum-one bootstrap partition so the parent is valid before pg_partman
-- takes over (bill_run_account/bill_run_account_stage precedent,
-- 0028_bill_run_account_stage.sql). pg_partman's create_parent +
-- run_maintenance_proc (db/bootstrap/billing-partman-setup.sql, run once per
-- environment) then materialise the premake/forward partitions.
CREATE TABLE "billing"."customer_bill_default" PARTITION OF "billing"."customer_bill" DEFAULT;
