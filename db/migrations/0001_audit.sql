-- um27: core.audit_log is born partitioned (PARTITION BY RANGE created_datetime)
-- and ULID-keyed. This file is the DDL of record for the partitioned parent;
-- pg_partman/pg_cron provisioning (create_parent, premake, retention, the daily
-- maintenance cron) lives in db/bootstrap/audit-partman-setup.sql, run once per
-- environment under an elevated connection AFTER this migration — see that file
-- and infra/docs/audit-partman-setup.md.

-- pgcrypto provides gen_random_bytes() (used by core.generate_ulid below).
-- gen_random_uuid() is in core Postgres, but gen_random_bytes() is not — it
-- ships in pgcrypto, a trusted extension a CREATE-on-database role can install.
CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint

-- core.generate_ulid(): 48-bit ms timestamp + 80-bit randomness, emitted as uuid.
CREATE OR REPLACE FUNCTION core.generate_ulid() RETURNS uuid
  LANGUAGE plpgsql AS $$
DECLARE
  ms       bigint := floor(extract(epoch from clock_timestamp()) * 1000);
  ts_bytes bytea  := substring(int8send(ms) from 3 for 6);  -- low 48 bits, big-endian
BEGIN
  RETURN encode(ts_bytes || gen_random_bytes(10), 'hex')::uuid;  -- 6 + 10 = 16 bytes
END;
$$;
--> statement-breakpoint

-- Partitioned parent. Composite PK is required because created_datetime is the
-- partition key. Indexes/FK declared on the parent propagate to all partitions.
CREATE TABLE "core"."audit_log" (
  "audit_id"         uuid NOT NULL DEFAULT core.generate_ulid(),
  "event_type"       text NOT NULL,
  "actor_user_id"    text,
  "target_entity"    text,
  "target_id"        text,
  "before_data"      jsonb,
  "after_data"       jsonb,
  "created_datetime" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "audit_log_pkey" PRIMARY KEY ("audit_id", "created_datetime")
) PARTITION BY RANGE ("created_datetime");
--> statement-breakpoint

ALTER TABLE "core"."audit_log"
  ADD CONSTRAINT "audit_log_actor_user_id_appuser_user_id_fk"
  FOREIGN KEY ("actor_user_id") REFERENCES "core"."appuser"("user_id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "audit_log_actor_user_id_idx"   ON "core"."audit_log" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "audit_log_event_type_idx"      ON "core"."audit_log" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "audit_log_created_datetime_idx" ON "core"."audit_log" USING btree ("created_datetime");--> statement-breakpoint

-- Minimum-one bootstrap partition so the parent is valid before pg_partman
-- takes over (plan §3.2). pg_partman's create_parent + run_maintenance_proc
-- (provisioning step) then materialise the premake/forward partitions.
CREATE TABLE "core"."audit_log_default" PARTITION OF "core"."audit_log" DEFAULT;
