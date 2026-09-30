CREATE SCHEMA "rating";
--> statement-breakpoint
ALTER TYPE "product"."lifecycle_status" ADD VALUE 'TESTING' BEFORE 'ACTIVE';--> statement-breakpoint
ALTER TYPE "product"."lifecycle_status" ADD VALUE 'OBSOLETE' BEFORE 'RETIRED';--> statement-breakpoint
CREATE SEQUENCE "product"."ratecard_version_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "billing"."bill_run_account_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "billing"."bill_run_account_stage_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "billing"."customer_bill_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "billing"."customer_bill_line_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "billing"."customer_bill_tax_item_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "billing"."bill_run_invoice_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "billing"."document_inv_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "rating"."udr_batch_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "product"."ratecard_ran_usage_lkp" (
	"ratecard_ran_usage_lkp_id" uuid PRIMARY KEY DEFAULT core.generate_ulid() NOT NULL,
	"ratecard_version_id" text NOT NULL,
	"mno_public_key" text NOT NULL,
	"commercial_unit_public_key" text NOT NULL,
	"polygon_id" text NOT NULL,
	"polygon_start_date" date NOT NULL,
	"lkp_subscriber_ref_id" text NOT NULL,
	"service_code" text,
	"rate_per_unit" numeric(18, 6),
	"retired_at" date,
	CONSTRAINT "ratecard_ran_usage_lkp_row_key_unique" UNIQUE("ratecard_version_id","mno_public_key","commercial_unit_public_key","polygon_id","polygon_start_date")
);
--> statement-breakpoint
CREATE TABLE "product"."ratecard_version" (
	"ratecard_version_id" text PRIMARY KEY DEFAULT 'RCV' || lpad(nextval('product.ratecard_version_seq')::text, 8, '0') NOT NULL,
	"card_name" text NOT NULL,
	"version_num" integer NOT NULL,
	"status" text NOT NULL,
	"snapshot_date" date NOT NULL,
	"source_file" text NOT NULL,
	"file_checksum" text,
	"row_count" integer NOT NULL,
	"carried_row_count" integer DEFAULT 0 NOT NULL,
	"uploaded_by" text,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_by" text,
	"activated_at" timestamp with time zone,
	"superseded_by_version_id" text,
	"reject_summary" jsonb,
	CONSTRAINT "ratecard_version_card_name_version_num_unique" UNIQUE("card_name","version_num"),
	CONSTRAINT "ratecard_version_status_check" CHECK (status IN ('DRAFT','ACTIVE','SUPERSEDED','REJECTED'))
);
--> statement-breakpoint
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
);
--> statement-breakpoint
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
);
--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE TABLE "billing"."customer_bill_line" (
	"customer_bill_line_id" text DEFAULT 'BLN' || lpad(nextval('billing.customer_bill_line_seq')::text, 8, '0') NOT NULL,
	"ref_customer_bill_id" text NOT NULL,
	"period_partition" date NOT NULL,
	"line_no" integer NOT NULL,
	"source" text NOT NULL,
	"line_type" text DEFAULT 'charge' NOT NULL,
	"ref_product_offering_id" text NOT NULL,
	"udr_type" text,
	"description" text,
	"quantity" numeric(20, 6),
	"unit" text,
	"gross_amount" numeric(18, 2) NOT NULL,
	"discount_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"net_amount" numeric(18, 2) NOT NULL,
	"discount_type" text,
	"discount_rate" numeric(18, 6),
	"discount_amount_raw" numeric(18, 6),
	"udr_count" integer,
	"grouping_key" text NOT NULL,
	"currency" char(3) NOT NULL,
	"snapshot_price_ref" text,
	"snapshot_unit_price" numeric(18, 6),
	"snapshot_quantity" numeric(20, 6),
	"snapshot_effective_date" date
);
--> statement-breakpoint
CREATE TABLE "billing"."customer_bill_tax_item" (
	"customer_bill_tax_item_id" text DEFAULT 'CBT' || lpad(nextval('billing.customer_bill_tax_item_seq')::text, 8, '0') NOT NULL,
	"ref_customer_bill_id" text NOT NULL,
	"period_partition" date NOT NULL,
	"tax_category" text NOT NULL,
	"tax_rate" numeric(5, 2) NOT NULL,
	"tax_amount" numeric(18, 2) NOT NULL,
	CONSTRAINT "customer_bill_tax_item_customer_bill_tax_item_id_period_partition_pk" PRIMARY KEY("customer_bill_tax_item_id","period_partition")
);
--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE TABLE "rating"."udr_rated" (
	"udr_id" uuid DEFAULT core.generate_ulid() NOT NULL,
	"partition_period" date NOT NULL,
	"udr_type" text NOT NULL,
	"start_datetime" timestamp with time zone NOT NULL,
	"end_datetime" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'RATED' NOT NULL,
	"is_live" boolean GENERATED ALWAYS AS (CASE WHEN status IN ('RATED','BILL_DRAFT','BILL_APPROVED') THEN true END) STORED,
	"udr_subscriber_ref_id" text NOT NULL,
	"udr_key" text NOT NULL,
	"udr_resource" text,
	"udr_usage_quantity" numeric(20, 6) NOT NULL,
	"udr_usage_unit" text NOT NULL,
	"udr_usage_rate" numeric(18, 6),
	"udr_rate_type" text NOT NULL,
	"udr_rate_detail" jsonb,
	"udr_rated_price" numeric(18, 2) NOT NULL,
	"udr_rated_price_raw" numeric(18, 6) NOT NULL,
	"udr_rounding_mode" text NOT NULL,
	"udr_discount_amount" numeric(18, 2),
	"udr_discount_amount_raw" numeric(18, 6),
	"udr_discount_type" text,
	"udr_discount_rate" numeric(18, 6),
	"udr_discount_authority_ref" text,
	"udr_currency" char(3) NOT NULL,
	"udr_subscription_rateplan_ref" text,
	"udr_price_ref" text,
	"udr_price_effective_date" timestamp with time zone,
	"udr_price_override_ref" text,
	"billrun_ref_id" text,
	"billrun_ban_id" text,
	"billrun_attempt" integer,
	"billrun_checksum" text,
	"udr_ref_batch_id" text NOT NULL,
	"udr_source_file" text NOT NULL,
	"rating_engine_version" text NOT NULL,
	"rating_flow_revision" integer NOT NULL,
	"udr_loader_instance_id" text,
	"rated_datetime" timestamp (3) with time zone,
	"insert_datetime" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"upsert_datetime" timestamp (3) with time zone,
	CONSTRAINT "udr_rated_pk" PRIMARY KEY("partition_period","udr_id"),
	CONSTRAINT "udr_rated_live_uq" UNIQUE("partition_period","start_datetime","udr_key","is_live"),
	CONSTRAINT "udr_rated_udr_key_length_check" CHECK (char_length(udr_key) <= 512),
	CONSTRAINT "udr_rated_period_matches_check" CHECK (partition_period = rating.period_of(start_datetime)),
	CONSTRAINT "udr_rated_status_check" CHECK (status IN ('RATED','BILL_DRAFT','BILL_APPROVED','REJECTED','SUPERSEDED','BILL_NOTUSED')),
	CONSTRAINT "udr_rated_rate_type_check" CHECK (udr_rate_type IN ('FLAT','PER_UNIT','TIERED_GRADUATED','TIERED_VOLUME','BLOCK','PERCENTAGE','ZERO_RATED')),
	CONSTRAINT "udr_rated_discount_type_check" CHECK (udr_discount_type IS NULL OR udr_discount_type IN ('fixed','percentage')),
	CONSTRAINT "udr_rated_rounding_mode_check" CHECK (udr_rounding_mode IN ('HALF_UP','HALF_EVEN','TRUNCATE')),
	CONSTRAINT "udr_rated_end_after_start_check" CHECK (end_datetime >= start_datetime)
);
--> statement-breakpoint
CREATE TABLE "rating"."udr_batch" (
	"batch_id" text PRIMARY KEY DEFAULT 'UDRBAT' || lpad(nextval('rating.udr_batch_seq')::text, 8, '0') NOT NULL,
	"file_key" text NOT NULL,
	"source_file" text NOT NULL,
	"file_key_rule" text NOT NULL,
	"udr_type" text NOT NULL,
	"batch_run_num" integer DEFAULT 1 NOT NULL,
	"file_checksum" text,
	"file_size_bytes" bigint,
	"status" text DEFAULT 'RECEIVED' NOT NULL,
	"received_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp (3) with time zone,
	"completed_at" timestamp (3) with time zone,
	"declared_record_count" integer,
	"parsed_count" integer,
	"rated_count" integer,
	"rejected_count" integer,
	"discarded_count" integer,
	"superseded_count" integer,
	"reject_file_path" text,
	"archive_file_path" text,
	"workflow_execution_id" text,
	"workflow_flow_revision" integer,
	"rating_engine_version" text,
	"superseded_by_batch_id" text,
	"supersede_reason" text,
	"error_summary" text,
	CONSTRAINT "udr_batch_file_key_run_uq" UNIQUE("file_key","batch_run_num"),
	CONSTRAINT "udr_batch_status_check" CHECK (status IN ('RECEIVED','PROCESSING','COMPLETE','PARTIAL','FAILED','REFUSED')),
	CONSTRAINT "udr_batch_run_num_positive_check" CHECK (batch_run_num >= 1)
);
--> statement-breakpoint
CREATE TABLE "rating"."process_log" (
	"log_id" uuid DEFAULT core.generate_ulid() NOT NULL,
	"partition_period" date NOT NULL,
	"log_datetime" timestamp (3) with time zone NOT NULL,
	"component" text NOT NULL,
	"log_level" text NOT NULL,
	"perceived_severity" text,
	"event_code" text NOT NULL,
	"event_type" text,
	"probable_cause" text,
	"specific_problem" text,
	"managed_object" text,
	"alarm_key" text,
	"source_file" text,
	"batch_id" text,
	"workflow_execution_id" text,
	"additional_info" jsonb,
	"insert_datetime" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "process_log_pk" PRIMARY KEY("partition_period","log_id"),
	CONSTRAINT "process_log_period_matches_check" CHECK (partition_period = rating.period_of(log_datetime)),
	CONSTRAINT "process_log_component_check" CHECK (component IN ('PRP','RP','RL','LOG_SWEEP','SCHEDULER')),
	CONSTRAINT "process_log_level_check" CHECK (log_level IN ('DEBUG','INFO','WARN','ERROR')),
	CONSTRAINT "process_log_severity_check" CHECK (perceived_severity IS NULL OR perceived_severity IN ('CRITICAL','MAJOR','MINOR','WARNING','INDETERMINATE','CLEARED'))
);
--> statement-breakpoint
CREATE TABLE "rating"."event_catalog" (
	"event_code" text PRIMARY KEY NOT NULL,
	"component" text,
	"default_severity" text,
	"event_type" text,
	"probable_cause" text,
	"description" text NOT NULL,
	"is_auto_clearing" boolean DEFAULT false NOT NULL,
	"clear_event_code" text,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" DROP CONSTRAINT "product_offering_price_type_check";--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" DROP CONSTRAINT "product_offering_price_pricing_model_check";--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" DROP CONSTRAINT "product_offering_price_amount_xor_tiers_check";--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" DROP CONSTRAINT "product_offering_price_amount_check";--> statement-breakpoint
ALTER TABLE "billing"."reason_code" DROP CONSTRAINT "reason_code_doc_type_check";--> statement-breakpoint
ALTER TABLE "billing"."document" DROP CONSTRAINT "document_doc_type_check";--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" DROP CONSTRAINT "product_offering_price_product_offering_id_product_offering_product_offering_id_fk";
--> statement-breakpoint
ALTER TABLE "product"."product_specifications" DROP CONSTRAINT "product_specifications_ref_product_offering_id_product_offering_product_offering_id_fk";
--> statement-breakpoint
DROP INDEX "product"."product_offering_price_type_start_unique";--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" ADD COLUMN "component_type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" ADD COLUMN "price_component" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "billing"."bill_run" ADD COLUMN "processing_execution_id" text;--> statement-breakpoint
ALTER TABLE "billing"."bill_run" ADD COLUMN "processing_flow_id" text;--> statement-breakpoint
ALTER TABLE "billing"."bill_run" ADD COLUMN "processing_flow_revision" integer;--> statement-breakpoint
ALTER TABLE "billing"."bill_run" ADD COLUMN "processing_engine_ref" text;--> statement-breakpoint
ALTER TABLE "billing"."bill_run" ADD COLUMN "distribution_execution_id" text;--> statement-breakpoint
ALTER TABLE "billing"."bill_run" ADD COLUMN "distribution_flow_id" text;--> statement-breakpoint
ALTER TABLE "billing"."bill_run" ADD COLUMN "distribution_flow_revision" integer;--> statement-breakpoint
ALTER TABLE "billing"."bill_run" ADD COLUMN "distribution_engine_ref" text;--> statement-breakpoint
ALTER TABLE "billing"."bill_run" ADD COLUMN "distribution_attempt" integer;--> statement-breakpoint
ALTER TABLE "billing"."document" ADD COLUMN "ref_customer_bill_id" text;--> statement-breakpoint
ALTER TABLE "billing"."document" ADD COLUMN "period_partition" date;--> statement-breakpoint
ALTER TABLE "product"."ratecard_ran_usage_lkp" ADD CONSTRAINT "ratecard_ran_usage_lkp_ratecard_version_id_ratecard_version_ratecard_version_id_fk" FOREIGN KEY ("ratecard_version_id") REFERENCES "product"."ratecard_version"("ratecard_version_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product"."ratecard_version" ADD CONSTRAINT "ratecard_version_uploaded_by_appuser_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "core"."appuser"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product"."ratecard_version" ADD CONSTRAINT "ratecard_version_activated_by_appuser_user_id_fk" FOREIGN KEY ("activated_by") REFERENCES "core"."appuser"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."bill_run_account" ADD CONSTRAINT "bill_run_account_ref_bill_run_id_bill_run_bill_run_id_fk" FOREIGN KEY ("ref_bill_run_id") REFERENCES "billing"."bill_run"("bill_run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."bill_run_account" ADD CONSTRAINT "bill_run_account_ref_billing_account_id_billing_account_billing_account_id_fk" FOREIGN KEY ("ref_billing_account_id") REFERENCES "billing"."billing_account"("billing_account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."bill_run_account_stage" ADD CONSTRAINT "bill_run_account_stage_ref_bill_run_id_bill_run_bill_run_id_fk" FOREIGN KEY ("ref_bill_run_id") REFERENCES "billing"."bill_run"("bill_run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."bill_run_account_stage" ADD CONSTRAINT "bill_run_account_stage_ref_billing_account_id_billing_account_billing_account_id_fk" FOREIGN KEY ("ref_billing_account_id") REFERENCES "billing"."billing_account"("billing_account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."customer_bill" ADD CONSTRAINT "customer_bill_ref_bill_run_id_bill_run_bill_run_id_fk" FOREIGN KEY ("ref_bill_run_id") REFERENCES "billing"."bill_run"("bill_run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."customer_bill" ADD CONSTRAINT "customer_bill_ref_billing_account_id_billing_account_billing_account_id_fk" FOREIGN KEY ("ref_billing_account_id") REFERENCES "billing"."billing_account"("billing_account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."customer_bill_tax_item" ADD CONSTRAINT "customer_bill_tax_item_customer_bill_fk" FOREIGN KEY ("ref_customer_bill_id","period_partition") REFERENCES "billing"."customer_bill"("customer_bill_id","period_partition") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."bill_run_invoices" ADD CONSTRAINT "bill_run_invoices_ref_bill_run_id_bill_run_bill_run_id_fk" FOREIGN KEY ("ref_bill_run_id") REFERENCES "billing"."bill_run"("bill_run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."bill_run_invoices" ADD CONSTRAINT "bill_run_invoices_ref_billing_account_id_billing_account_billing_account_id_fk" FOREIGN KEY ("ref_billing_account_id") REFERENCES "billing"."billing_account"("billing_account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."bill_run_invoices" ADD CONSTRAINT "bill_run_invoices_ref_inv_document_id_document_document_id_fk" FOREIGN KEY ("ref_inv_document_id") REFERENCES "billing"."document"("document_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."bill_run_invoices" ADD CONSTRAINT "bill_run_invoices_customer_bill_fk" FOREIGN KEY ("ref_customer_bill_id","period_partition") REFERENCES "billing"."customer_bill"("customer_bill_id","period_partition") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ratecard_ran_usage_lkp_as_of_idx" ON "product"."ratecard_ran_usage_lkp" USING btree ("ratecard_version_id","mno_public_key","commercial_unit_public_key","polygon_id","polygon_start_date" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "ratecard_version_one_active_per_card" ON "product"."ratecard_version" USING btree ("card_name") WHERE "product"."ratecard_version"."status" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "ratecard_version_one_draft_per_card" ON "product"."ratecard_version" USING btree ("card_name") WHERE "product"."ratecard_version"."status" = 'DRAFT';--> statement-breakpoint
CREATE INDEX "bill_run_account_ref_bill_run_id_idx" ON "billing"."bill_run_account" USING btree ("ref_bill_run_id");--> statement-breakpoint
CREATE INDEX "bill_run_account_period_partition_idx" ON "billing"."bill_run_account" USING btree ("period_partition");--> statement-breakpoint
CREATE INDEX "bill_run_account_stage_ref_bill_run_id_idx" ON "billing"."bill_run_account_stage" USING btree ("ref_bill_run_id");--> statement-breakpoint
CREATE INDEX "bill_run_account_stage_period_partition_idx" ON "billing"."bill_run_account_stage" USING btree ("period_partition");--> statement-breakpoint
CREATE INDEX "customer_bill_ref_bill_run_id_idx" ON "billing"."customer_bill" USING btree ("ref_bill_run_id");--> statement-breakpoint
CREATE INDEX "customer_bill_period_partition_idx" ON "billing"."customer_bill" USING btree ("period_partition");--> statement-breakpoint
CREATE INDEX "customer_bill_tax_item_ref_customer_bill_id_idx" ON "billing"."customer_bill_tax_item" USING btree ("ref_customer_bill_id");--> statement-breakpoint
CREATE INDEX "customer_bill_tax_item_period_partition_idx" ON "billing"."customer_bill_tax_item" USING btree ("period_partition");--> statement-breakpoint
CREATE INDEX "bill_run_invoices_ref_bill_run_id_idx" ON "billing"."bill_run_invoices" USING btree ("ref_bill_run_id");--> statement-breakpoint
CREATE INDEX "bill_run_invoices_period_partition_idx" ON "billing"."bill_run_invoices" USING btree ("period_partition");--> statement-breakpoint
CREATE INDEX "udr_rated_subscriber_start_idx" ON "rating"."udr_rated" USING btree ("udr_subscriber_ref_id","start_datetime");--> statement-breakpoint
CREATE INDEX "udr_rated_billrun_idx" ON "rating"."udr_rated" USING btree ("billrun_ref_id","billrun_ban_id","billrun_attempt") WHERE billrun_ref_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "udr_rated_batch_idx" ON "rating"."udr_rated" USING btree ("udr_ref_batch_id");--> statement-breakpoint
CREATE INDEX "udr_rated_orphan_idx" ON "rating"."udr_rated" USING btree ("udr_key") WHERE is_live IS NULL;--> statement-breakpoint
CREATE INDEX "udr_batch_file_key_idx" ON "rating"."udr_batch" USING btree ("file_key","batch_run_num" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "process_log_alarm_idx" ON "rating"."process_log" USING btree ("perceived_severity","log_datetime") WHERE perceived_severity IS NOT NULL;--> statement-breakpoint
CREATE INDEX "process_log_alarm_key_idx" ON "rating"."process_log" USING btree ("alarm_key") WHERE alarm_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "process_log_batch_idx" ON "rating"."process_log" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "process_log_event_code_idx" ON "rating"."process_log" USING btree ("event_code");--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" ADD CONSTRAINT "product_offering_price_product_offering_id_product_offering_product_offering_id_fk" FOREIGN KEY ("product_offering_id") REFERENCES "product"."product_offering"("product_offering_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product"."product_specifications" ADD CONSTRAINT "product_specifications_ref_product_offering_id_product_offering_product_offering_id_fk" FOREIGN KEY ("ref_product_offering_id") REFERENCES "product"."product_offering"("product_offering_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."document" ADD CONSTRAINT "document_customer_bill_fk" FOREIGN KEY ("ref_customer_bill_id","period_partition") REFERENCES "billing"."customer_bill"("customer_bill_id","period_partition") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_offering_one_active_per_family" ON "product"."product_offering" USING btree ((coalesce("family_offering_id", "product_offering_id"))) WHERE "product"."product_offering"."lifecycle_status" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "product_offering_one_open_per_family" ON "product"."product_offering" USING btree ((coalesce("family_offering_id", "product_offering_id"))) WHERE "product"."product_offering"."lifecycle_status" IN ('DRAFT','TESTING');--> statement-breakpoint
CREATE INDEX "product_offering_price_component_type_idx" ON "product"."product_offering_price" USING btree ("component_type");--> statement-breakpoint
CREATE UNIQUE INDEX "document_ref_customer_bill_id_unique" ON "billing"."document" USING btree ("ref_customer_bill_id") WHERE ref_customer_bill_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" DROP COLUMN "price_type";--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" DROP COLUMN "amount";--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" DROP COLUMN "pricing_model";--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" DROP COLUMN "pricing_characteristics";--> statement-breakpoint
ALTER TABLE "billing"."bill_run" DROP COLUMN "workflow_execution_id";--> statement-breakpoint
ALTER TABLE "billing"."bill_run" DROP COLUMN "workflow_definition_id";--> statement-breakpoint
ALTER TABLE "billing"."bill_run" DROP COLUMN "workflow_definition_revision";--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" ADD CONSTRAINT "product_offering_price_component_start_unique" UNIQUE NULLS NOT DISTINCT("product_offering_id","component_type","unit_of_measure","start_date_time");--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" ADD CONSTRAINT "product_offering_price_period_value_check" CHECK (recurring_charge_period_type IS NULL OR (recurring_charge_period_type = 'months' AND recurring_charge_period_length IN (1, 3, 12)));--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" ADD CONSTRAINT "product_offering_price_unit_value_check" CHECK (unit_of_measure IS NULL OR unit_of_measure IN ('Mbps', 'GB', 'MB', 'EA'));--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" ADD CONSTRAINT "product_offering_price_component_type_check" CHECK (component_type IN ('usage_rate','flat_fee','capacity_commitment','capacity_motivation'));--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" ADD CONSTRAINT "product_offering_price_envelope_type_check" CHECK (component_type = price_component ->> '@type');--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" ADD CONSTRAINT "product_offering_price_usage_rate_check" CHECK (component_type <> 'usage_rate' OR (unit_of_measure IS NOT NULL AND recurring_charge_period_length IS NULL AND recurring_charge_period_type IS NULL AND COALESCE(jsonb_typeof(price_component #> '{params,ratePerUnit}'), 'missing') = 'string' AND price_component #>> '{params,ratePerUnit}' ~ '^[0-9]+(\.[0-9]+)?$'));--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" ADD CONSTRAINT "product_offering_price_flat_fee_check" CHECK (component_type <> 'flat_fee' OR (unit_of_measure IS NULL AND COALESCE(jsonb_typeof(price_component #> '{params,amount}'), 'missing') = 'string' AND price_component #>> '{params,amount}' ~ '^[0-9]+(\.[0-9]+)?$' AND COALESCE(price_component ->> 'priceType', '') IN ('recurring', 'oneTime') AND ((price_component ->> 'priceType' = 'recurring' AND recurring_charge_period_length IS NOT NULL AND recurring_charge_period_type IS NOT NULL) OR (price_component ->> 'priceType' = 'oneTime' AND recurring_charge_period_length IS NULL AND recurring_charge_period_type IS NULL))));--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" ADD CONSTRAINT "product_offering_price_capacity_commitment_check" CHECK (component_type <> 'capacity_commitment' OR (unit_of_measure IS NOT NULL AND recurring_charge_period_length IS NULL AND recurring_charge_period_type IS NULL AND CASE WHEN jsonb_typeof(price_component #> '{params,committedQuantity}') = 'number' THEN (price_component #>> '{params,committedQuantity}')::numeric > 0 ELSE false END));--> statement-breakpoint
ALTER TABLE "product"."product_offering_price" ADD CONSTRAINT "product_offering_price_capacity_motivation_check" CHECK (component_type <> 'capacity_motivation' OR (unit_of_measure IS NOT NULL AND recurring_charge_period_length IS NULL AND recurring_charge_period_type IS NULL AND product.pricing_steps_ok(price_component #> '{params,steps}')));--> statement-breakpoint
ALTER TABLE "billing"."reason_code" ADD CONSTRAINT "reason_code_doc_type_check" CHECK (doc_type IN ('PAY','DEP','CRN','DBN','ADJ','INV'));--> statement-breakpoint
ALTER TABLE "billing"."document" ADD CONSTRAINT "document_customer_bill_ref_paired_check" CHECK ((ref_customer_bill_id IS NULL) = (period_partition IS NULL));--> statement-breakpoint
ALTER TABLE "billing"."document" ADD CONSTRAINT "document_customer_bill_ref_inv_only_check" CHECK (ref_customer_bill_id IS NULL OR doc_type = 'INV');--> statement-breakpoint
ALTER TABLE "billing"."document" ADD CONSTRAINT "document_doc_type_check" CHECK (doc_type IN ('PAY','DEP','CRN','DBN','ADJ','INV'));