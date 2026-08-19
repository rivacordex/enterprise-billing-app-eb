CREATE SEQUENCE "billing"."bill_run_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "billing"."bill_run" (
	"bill_run_id" text PRIMARY KEY DEFAULT 'BRN' || lpad(nextval('billing.bill_run_seq')::text, 8, '0') NOT NULL,
	"ref_bill_cycle_id" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"scheduled_run_date" date NOT NULL,
	"status" text DEFAULT 'SCHEDULED' NOT NULL,
	"run_type" text DEFAULT 'onCycle' NOT NULL,
	"workflow_execution_id" text,
	"workflow_definition_id" text,
	"workflow_definition_revision" integer,
	"last_progress_at" timestamp (3) with time zone,
	"gl_event_at" date,
	"ref_tax_rate_version" text,
	"ban_count" integer,
	"rated_count" integer,
	"failed_count" integer,
	"total_amount" numeric(18, 2),
	"triggered_by" text,
	"approved_by" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp (3) with time zone,
	"approved_at" timestamp (3) with time zone,
	"posting_started_at" timestamp (3) with time zone,
	"invoiced_at" timestamp (3) with time zone,
	"distributing_at" timestamp (3) with time zone,
	"completed_at" timestamp (3) with time zone,
	CONSTRAINT "bill_run_cycle_period_unique" UNIQUE("ref_bill_cycle_id","period_start"),
	CONSTRAINT "bill_run_status_check" CHECK (status IN ('SCHEDULED','PROCESSING','PROCESSED','APPROVED','POSTING','INVOICED','DISTRIBUTING','COMPLETED','PROCESSING_FAILED','DISTRIBUTION_FAILED','CANCELLED')),
	CONSTRAINT "bill_run_run_type_check" CHECK (run_type IN ('onCycle','offCycle')),
	CONSTRAINT "bill_run_approver_distinct_check" CHECK (approved_by IS NULL OR approved_by <> triggered_by)
);
--> statement-breakpoint
ALTER TABLE "billing"."bill_run" ADD CONSTRAINT "bill_run_ref_bill_cycle_id_bill_cycle_bill_cycle_id_fk" FOREIGN KEY ("ref_bill_cycle_id") REFERENCES "billing"."bill_cycle"("bill_cycle_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."bill_run" ADD CONSTRAINT "bill_run_triggered_by_appuser_user_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "core"."appuser"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."bill_run" ADD CONSTRAINT "bill_run_approved_by_appuser_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "core"."appuser"("user_id") ON DELETE restrict ON UPDATE no action;