-- bm03-spec §Design/Implementation §3 — pg_partman provisioning for
-- billing.bill_run_account, the first billing-module partitioned table
-- (bm04/bm05/bm06's partitioned tables extend this bootstrap). Mirrors
-- db/bootstrap/audit-partman-setup.sql exactly: CREATE EXTENSION and
-- partman.create_parent need privileges above the least-privilege
-- `app_migrate` role, so this runs ONCE per environment under a
-- superuser/owner connection, AFTER `0027_bill_run_account.sql` has created
-- the partitioned parent — via `npm run db:setup-partman-billing`
-- (db/bootstrap/billing-partman-setup.ts reads BOOTSTRAP_DATABASE_URL, never
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

-- Register the parent: monthly range partitions on period_partition.
-- p_default_table := false: the migration (0027_bill_run_account.sql)
-- already created and attached billing.bill_run_account_default as the
-- DEFAULT partition (audit_log precedent) — pg_partman must not try to manage
-- its own.
SELECT partman.create_parent(
  p_parent_table  := 'billing.bill_run_account',
  p_control       := 'period_partition',
  p_interval      := '1 month',
  p_type          := 'range',
  p_premake       := 4,           -- keep 4 future months pre-created
  p_default_table := false
);
--> statement-breakpoint

-- 7-year (84-partition) retention; DETACH (never drop) an out-of-window
-- partition — architecture §6.9's archival contract, unlike audit_log's
-- drop-on-expiry policy.
UPDATE partman.part_config
SET retention            = '7 years',
    retention_keep_table = true,
    premake              = 4,
    infinite_time_partitions = true
WHERE parent_table = 'billing.bill_run_account';
--> statement-breakpoint

-- Materialise premake/forward partitions immediately on a fresh install.
CALL partman.run_maintenance_proc();

-- No second cron job: the audit-log-partman-maintenance job
-- (audit-partman-setup.sql) already calls partman.run_maintenance_proc()
-- with no table argument, which sweeps every registered parent — including
-- this one once the create_parent call above has run. Do not schedule a
-- second `cron.schedule_in_database` here.
