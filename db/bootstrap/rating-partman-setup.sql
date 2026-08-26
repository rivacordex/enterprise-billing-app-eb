-- rm01-spec §Implementation §6 — pg_partman provisioning for the two
-- high-volume `rating` tables. Mirrors db/bootstrap/billing-partman-setup.sql
-- exactly: CREATE EXTENSION and partman.create_parent need privileges above
-- the least-privilege `app_migrate` role, so this runs ONCE per environment
-- under a superuser/owner connection, AFTER `0034_rating.sql` has created the
-- partitioned parents — via `npm run db:setup-partman-rating`
-- (db/bootstrap/rating-partman-setup.ts reads BOOTSTRAP_DATABASE_URL, never
-- the app's DATABASE_URL) or directly with `psql`.
--
-- pg_partman/pg_cron are already provisioned by audit-partman-setup.sql
-- (CREATE EXTENSION IF NOT EXISTS is idempotent either way); this file does
-- not repeat CREATE SCHEMA/CREATE EXTENSION for them, but includes the
-- IF NOT EXISTS guards so it also runs cleanly standalone.
--
-- The statement-breakpoint marker lines below let the .ts runner split the
-- file into individual statements; they are SQL line comments, so running the
-- whole file through `psql` works too.
CREATE SCHEMA IF NOT EXISTS partman;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_partman SCHEMA partman;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_cron;
--> statement-breakpoint

-- Preflight: fail loudly rather than emit broken DDL if pg_partman is absent
-- or pre-v5 (_risk-database-extension-version-drift.md §4.1). The
-- create_parent() calls below use pg_partman v5's named-parameter signature.
DO $$
DECLARE v text;
BEGIN
  SELECT extversion INTO v FROM pg_extension WHERE extname = 'pg_partman';
  IF v IS NULL THEN RAISE EXCEPTION 'pg_partman is not installed on this server'; END IF;
  IF split_part(v, '.', 1)::int < 5 THEN
    RAISE EXCEPTION 'pg_partman % found; this script uses the v5 named-parameter create_parent() signature.', v;
  END IF;
END $$;
--> statement-breakpoint

-- Register the parent: monthly range partitions on partition_period.
-- p_default_table := false: the migration (0034_rating.sql) already created
-- and attached rating.udr_rated_default as the DEFAULT partition (audit_log
-- precedent) — pg_partman must not try to manage its own.
SELECT partman.create_parent(
  p_parent_table  := 'rating.udr_rated',
  p_control       := 'partition_period',
  p_interval      := '1 month',
  p_type          := 'range',
  p_premake       := 4,           -- keep 4 future months pre-created
  p_default_table := false
);
--> statement-breakpoint

-- 7-year retention; DETACH (never drop) an out-of-window partition —
-- financial record, matches the billing tables' archival contract and the
-- invoice's statutory life (rm01-spec D7).
UPDATE partman.part_config
   SET retention = '7 years', retention_keep_table = true,
       infinite_time_partitions = true
 WHERE parent_table = 'rating.udr_rated';
--> statement-breakpoint

-- Second parent registration in this same bootstrap file: rating.process_log
-- (created by 0034_rating.sql). Same monthly/DETACH shape as udr_rated above,
-- but a shorter 24-month retention — operational telemetry aligned to the
-- 24-month retention of the log files it is loaded from (rm01-spec D7).
SELECT partman.create_parent(
  p_parent_table  := 'rating.process_log',
  p_control       := 'partition_period',
  p_interval      := '1 month',
  p_type          := 'range',
  p_premake       := 4,
  p_default_table := false
);
--> statement-breakpoint

UPDATE partman.part_config
   SET retention = '24 months', retention_keep_table = true,
       infinite_time_partitions = true
 WHERE parent_table = 'rating.process_log';
--> statement-breakpoint

-- Materialise premake/forward partitions immediately on a fresh install
-- (covers both parents registered above).
CALL partman.run_maintenance_proc();

-- No second cron job: the audit-log-partman-maintenance job
-- (audit-partman-setup.sql) already calls partman.run_maintenance_proc()
-- with no table argument, which sweeps every registered parent — including
-- both parents registered in this file, once their create_parent calls have
-- run. Do not schedule a second `cron.schedule_in_database` here.
