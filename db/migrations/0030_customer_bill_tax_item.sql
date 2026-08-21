CREATE SEQUENCE "billing"."customer_bill_tax_item_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "billing"."customer_bill_tax_item" (
	"customer_bill_tax_item_id" text DEFAULT 'CBT' || lpad(nextval('billing.customer_bill_tax_item_seq')::text, 8, '0') NOT NULL,
	"ref_customer_bill_id" text NOT NULL,
	"period_partition" date NOT NULL,
	"tax_category" text NOT NULL,
	"tax_rate" numeric(5, 2) NOT NULL,
	"tax_amount" numeric(18, 2) NOT NULL,
	CONSTRAINT "customer_bill_tax_item_customer_bill_tax_item_id_period_partition_pk" PRIMARY KEY("customer_bill_tax_item_id","period_partition")
) PARTITION BY RANGE ("period_partition");
--> statement-breakpoint
ALTER TABLE "billing"."customer_bill_tax_item" ADD CONSTRAINT "customer_bill_tax_item_customer_bill_fk" FOREIGN KEY ("ref_customer_bill_id","period_partition") REFERENCES "billing"."customer_bill"("customer_bill_id","period_partition") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_bill_tax_item_ref_customer_bill_id_idx" ON "billing"."customer_bill_tax_item" USING btree ("ref_customer_bill_id");--> statement-breakpoint
CREATE INDEX "customer_bill_tax_item_period_partition_idx" ON "billing"."customer_bill_tax_item" USING btree ("period_partition");--> statement-breakpoint

-- Minimum-one bootstrap partition so the parent is valid before pg_partman
-- takes over (customer_bill/bill_run_account_stage precedent,
-- 0029_customer_bill.sql). pg_partman's create_parent + run_maintenance_proc
-- (db/bootstrap/billing-partman-setup.sql, run once per environment) then
-- materialise the premake/forward partitions.
CREATE TABLE "billing"."customer_bill_tax_item_default" PARTITION OF "billing"."customer_bill_tax_item" DEFAULT;
