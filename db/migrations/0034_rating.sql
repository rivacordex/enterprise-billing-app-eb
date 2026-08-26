-- rm01-spec. HAND-AUTHORED migration — the DDL of record for the `rating`
-- schema (billmgmt-architecture.md um27 §2.6 / rm01-spec D2 precedent:
-- Drizzle cannot express PARTITION BY, CREATE FUNCTION or the composite PK on
-- a partitioned table). db/schema/rating/*.ts declares these tables for query
-- typing only — do not `drizzle-kit push` them.
--
-- pg_partman/pg_cron registration (rm01-spec §Implementation §6) lives in
-- db/bootstrap/rating-partman-setup.sql, run once per environment under an
-- elevated connection AFTER this migration.
CREATE SCHEMA "rating";
--> statement-breakpoint

-- The single home of the business-timezone literal (rm01-spec D3). IMMUTABLE
-- so it can be used in a CHECK constraint; verified session-independent
-- across UTC/America/New_York/Asia/Singapore sessions. The literal is UTC —
-- partition_period is a physical storage bucket, not the billing month
-- (rm01-spec D3) — and is not runtime-configurable.
CREATE FUNCTION "rating"."period_of"(ts timestamptz) RETURNS date
  LANGUAGE sql IMMUTABLE AS
$$ SELECT date_trunc('month', ts AT TIME ZONE 'UTC')::date $$;
--> statement-breakpoint

CREATE SEQUENCE "rating"."udr_batch_seq" INCREMENT BY 1 MINVALUE 1 START WITH 1 CACHE 1;
--> statement-breakpoint

-- rating.udr_rated — one row per rated usage record (rm01-spec §Implementation §2).
-- Composite PK is required because partition_period is the partition key
-- (Postgres requires the partition key in every unique/PK on a partitioned
-- table). `is_live` carries the live-row uniqueness constraint (rm01-spec D4):
-- GENERATED ALWAYS ... STORED from status, so it cannot drift from the value
-- it derives from. No foreign keys anywhere (Inv #17) — udr_ref_batch_id,
-- udr_subscriber_ref_id, udr_price_ref and udr_price_override_ref are plain
-- text.
CREATE TABLE "rating"."udr_rated" (
	"udr_id" uuid DEFAULT core.generate_ulid() NOT NULL,
	"partition_period" date NOT NULL,
	"udr_type" text NOT NULL,
	"start_datetime" timestamptz NOT NULL,
	"end_datetime" timestamptz NOT NULL,
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
	"udr_price_effective_date" timestamptz,
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
	CONSTRAINT "udr_rated_pk" PRIMARY KEY ("partition_period","udr_id"),
	CONSTRAINT "udr_rated_live_uq" UNIQUE ("partition_period","start_datetime","udr_key","is_live"),
	CONSTRAINT "udr_rated_udr_key_length_check" CHECK (char_length(udr_key) <= 512),
	CONSTRAINT "udr_rated_period_matches_check" CHECK (partition_period = rating.period_of(start_datetime)),
	CONSTRAINT "udr_rated_status_check" CHECK (status IN ('RATED','BILL_DRAFT','BILL_APPROVED','REJECTED','SUPERSEDED','BILL_NOTUSED')),
	CONSTRAINT "udr_rated_rate_type_check" CHECK (udr_rate_type IN ('FLAT','PER_UNIT','TIERED_GRADUATED','TIERED_VOLUME','BLOCK','PERCENTAGE','ZERO_RATED')),
	CONSTRAINT "udr_rated_discount_type_check" CHECK (udr_discount_type IS NULL OR udr_discount_type IN ('fixed','percentage')),
	CONSTRAINT "udr_rated_rounding_mode_check" CHECK (udr_rounding_mode IN ('HALF_UP','HALF_EVEN','TRUNCATE')),
	CONSTRAINT "udr_rated_end_after_start_check" CHECK (end_datetime >= start_datetime)
) PARTITION BY RANGE ("partition_period");
--> statement-breakpoint

CREATE INDEX "udr_rated_subscriber_start_idx" ON "rating"."udr_rated" USING btree (udr_subscriber_ref_id, start_datetime);
--> statement-breakpoint
CREATE INDEX "udr_rated_billrun_idx" ON "rating"."udr_rated" USING btree (billrun_ref_id, billrun_ban_id, billrun_attempt)
  WHERE billrun_ref_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "udr_rated_batch_idx" ON "rating"."udr_rated" USING btree (udr_ref_batch_id);
--> statement-breakpoint
CREATE INDEX "udr_rated_orphan_idx" ON "rating"."udr_rated" USING btree (udr_key) WHERE is_live IS NULL;
--> statement-breakpoint

-- Minimum-one bootstrap partition so the parent is valid before pg_partman
-- takes over (audit_log / bill_run_account precedent). A row landing here is
-- an alarm, not a normal state (rm01-spec D8) — it must stay empty.
CREATE TABLE "rating"."udr_rated_default" PARTITION OF "rating"."udr_rated" DEFAULT;
--> statement-breakpoint

-- rating.udr_batch — one row per processed file: the file claim, the
-- reconciliation ledger, and the batch-level lineage (rm01-spec §Implementation §3,
-- D11, D12). Not partitioned; low volume. `UNIQUE (file_key, batch_run_num)`
-- is the file claim (Inv #7), scoped to the logical delivery identity
-- (`file_key`, derived by PRP from the filename), never to `source_file`.
CREATE TABLE "rating"."udr_batch" (
	"batch_id" text DEFAULT 'UDRBAT' || lpad(nextval('rating.udr_batch_seq')::text, 8, '0') NOT NULL,
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
	CONSTRAINT "udr_batch_pk" PRIMARY KEY ("batch_id"),
	CONSTRAINT "udr_batch_file_key_run_uq" UNIQUE ("file_key","batch_run_num"),
	CONSTRAINT "udr_batch_status_check" CHECK (status IN ('RECEIVED','PROCESSING','COMPLETE','PARTIAL','FAILED','REFUSED')),
	CONSTRAINT "udr_batch_run_num_positive_check" CHECK (batch_run_num >= 1)
);
--> statement-breakpoint

CREATE INDEX "udr_batch_file_key_idx" ON "rating"."udr_batch" USING btree (file_key, batch_run_num DESC);
--> statement-breakpoint

-- rating.process_log — component activity, carrying both a syslog verbosity
-- level and a nullable ITU X.733 alarm severity (rm01-spec §Implementation §4).
-- `event_code` deliberately has no FK to event_catalog (rm01-spec D6): an
-- unrecognised code must resolve to INDETERMINATE and still load, or the
-- hygiene metric loses its only evidence.
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
	CONSTRAINT "process_log_pk" PRIMARY KEY ("partition_period","log_id"),
	CONSTRAINT "process_log_period_matches_check" CHECK (partition_period = rating.period_of(log_datetime)),
	CONSTRAINT "process_log_component_check" CHECK (component IN ('PRP','RP','RL','LOG_SWEEP','SCHEDULER')),
	CONSTRAINT "process_log_level_check" CHECK (log_level IN ('DEBUG','INFO','WARN','ERROR')),
	CONSTRAINT "process_log_severity_check" CHECK (perceived_severity IS NULL OR perceived_severity IN ('CRITICAL','MAJOR','MINOR','WARNING','INDETERMINATE','CLEARED'))
) PARTITION BY RANGE ("partition_period");
--> statement-breakpoint

CREATE INDEX "process_log_alarm_idx" ON "rating"."process_log" USING btree (perceived_severity, log_datetime)
  WHERE perceived_severity IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "process_log_alarm_key_idx" ON "rating"."process_log" USING btree (alarm_key) WHERE alarm_key IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "process_log_batch_idx" ON "rating"."process_log" USING btree (batch_id);
--> statement-breakpoint
CREATE INDEX "process_log_event_code_idx" ON "rating"."process_log" USING btree (event_code);
--> statement-breakpoint

-- Minimum-one bootstrap partition so the parent is valid before pg_partman
-- takes over (rm01-spec D8). Must stay empty.
CREATE TABLE "rating"."process_log_default" PARTITION OF "rating"."process_log" DEFAULT;
--> statement-breakpoint

-- rating.event_catalog — the seeded map from event_code to default severity,
-- X.733 event type and probable cause (rm01-spec §Implementation §5). Table
-- only; the seed is rm02.
CREATE TABLE "rating"."event_catalog" (
	"event_code" text PRIMARY KEY NOT NULL,
	"component" text,
	"default_severity" text,
	"event_type" text,
	"probable_cause" text,
	"description" text NOT NULL,
	"is_auto_clearing" boolean DEFAULT false NOT NULL,
	"clear_event_code" text,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "event_catalog_default_severity_check" CHECK (default_severity IS NULL OR default_severity IN ('CRITICAL','MAJOR','MINOR','WARNING','INDETERMINATE','CLEARED'))
);
