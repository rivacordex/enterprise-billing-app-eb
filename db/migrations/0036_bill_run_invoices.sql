CREATE SEQUENCE "billing"."bill_run_invoice_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "billing"."bill_run_invoices" (
	"bill_run_invoice_id" text DEFAULT 'BRI' || lpad(nextval('billing.bill_run_invoice_seq')::text, 8, '0') NOT NULL,
	"ref_bill_run_id" text NOT NULL,
	"ref_billing_account_id" text NOT NULL,
	"ref_customer_bill_id" text NOT NULL,
	"ref_inv_document_id" text NOT NULL,
	"blob_ref" text NOT NULL,
	"checksum" text NOT NULL,
	"rendered_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"period_partition" date NOT NULL,
	CONSTRAINT "bill_run_invoices_bill_run_invoice_id_period_partition_pk" PRIMARY KEY("bill_run_invoice_id","period_partition"),
	CONSTRAINT "bill_run_invoices_run_ban_period_unique" UNIQUE("ref_bill_run_id","ref_billing_account_id","period_partition")
) PARTITION BY RANGE ("period_partition");
--> statement-breakpoint
ALTER TABLE "billing"."bill_run_invoices" ADD CONSTRAINT "bill_run_invoices_ref_bill_run_id_bill_run_bill_run_id_fk" FOREIGN KEY ("ref_bill_run_id") REFERENCES "billing"."bill_run"("bill_run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."bill_run_invoices" ADD CONSTRAINT "bill_run_invoices_ref_billing_account_id_billing_account_billing_account_id_fk" FOREIGN KEY ("ref_billing_account_id") REFERENCES "billing"."billing_account"("billing_account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."bill_run_invoices" ADD CONSTRAINT "bill_run_invoices_ref_inv_document_id_document_document_id_fk" FOREIGN KEY ("ref_inv_document_id") REFERENCES "billing"."document"("document_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."bill_run_invoices" ADD CONSTRAINT "bill_run_invoices_customer_bill_fk" FOREIGN KEY ("ref_customer_bill_id","period_partition") REFERENCES "billing"."customer_bill"("customer_bill_id","period_partition") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bill_run_invoices_ref_bill_run_id_idx" ON "billing"."bill_run_invoices" USING btree ("ref_bill_run_id");--> statement-breakpoint
CREATE INDEX "bill_run_invoices_period_partition_idx" ON "billing"."bill_run_invoices" USING btree ("period_partition");--> statement-breakpoint

-- Minimum-one bootstrap partition so the parent is valid before pg_partman
-- takes over (customer_bill/customer_bill_tax_item precedent,
-- 0029_customer_bill.sql / 0030_customer_bill_tax_item.sql). pg_partman's
-- create_parent + run_maintenance_proc (db/bootstrap/billing-partman-
-- setup.sql, run once per environment) then materialise the
-- premake/forward partitions.
CREATE TABLE "billing"."bill_run_invoices_default" PARTITION OF "billing"."bill_run_invoices" DEFAULT;
--> statement-breakpoint

-- bm19-spec §Design "The stored PDF is the issued record — immutable,
-- 7-year (Inv #17)" / Verification checklist. Unlike the
-- customer_bill_finalization_guard (0033), this table has no "unfinalized"
-- state to distinguish — every row is born final (written only after its
-- INV has posted, in the separate render/store step, D10) — so this guard
-- is UNCONDITIONAL: any UPDATE or DELETE of an existing row is rejected,
-- full stop. Fires on every partition automatically (row-level triggers on a
-- partitioned parent apply to all partitions, PostgreSQL 11+), including
-- partitions pg_partman creates later.
CREATE OR REPLACE FUNCTION billing.bill_run_invoices_immutability_guard()
  RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'bill_run_invoices % is immutable and cannot be deleted',
      OLD.bill_run_invoice_id
      USING ERRCODE = '23001';
  ELSE
    RAISE EXCEPTION
      'bill_run_invoices % is immutable and cannot be updated',
      OLD.bill_run_invoice_id
      USING ERRCODE = '23001';
  END IF;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER bill_run_invoices_immutability_guard
  BEFORE UPDATE OR DELETE ON billing.bill_run_invoices
  FOR EACH ROW
  EXECUTE FUNCTION billing.bill_run_invoices_immutability_guard();
