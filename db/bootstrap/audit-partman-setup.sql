-- um27-spec §3.4 — pg_partman + pg_cron provisioning for core.audit_log.
--
-- NOT a Drizzle migration. CREATE EXTENSION, partman.create_parent, and
-- cron.schedule require privileges above the least-privilege `app_migrate`
-- role (Azure `azure_pg_admin` / the server admin) and create objects in the
-- `partman`/`cron` schemas. Mirrors the bootstrap-db-roles.sql pattern: run
-- ONCE per environment under a superuser/owner connection during provisioning,
-- AFTER `0001_audit.sql` has created the partitioned parent — via
-- `npm run db:setup-partman` (db/bootstrap/audit-partman-setup.ts reads
-- BOOTSTRAP_DATABASE_URL, a superuser/owner conn, never the app's DATABASE_URL)
-- or directly with `psql`. See infra/docs/audit-partman-setup.md.
--
-- The statement-breakpoint marker lines below let the .ts runner split the file
-- into individual statements; they are SQL line comments, so running the whole
-- file through `psql` works too.
--
-- create_parent signature shown is pg_partman v5.x (named params). If the Azure
-- image ships v4.x, the signature/p_type values differ ('native') — pin and
-- verify the installed version before running (see Open items §6.1 in the spec).
CREATE SCHEMA IF NOT EXISTS partman;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_partman SCHEMA partman;  -- v5+
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_cron;
--> statement-breakpoint

-- Register the parent: monthly range partitions on created_datetime.
-- p_default_table := false: the migration (0001_audit.sql) already created and
-- attached core.audit_log_default as the DEFAULT partition. pg_partman v5's
-- default behaviour (p_default_table := true) would try to CREATE+ATTACH its own
-- audit_log_default and fail with "already a partition". We keep the migration's
-- default and tell pg_partman not to manage one.
SELECT partman.create_parent(
  p_parent_table  := 'core.audit_log',
  p_control       := 'created_datetime',
  p_interval      := '1 month',
  p_type          := 'range',
  p_premake       := 4,           -- keep 4 future months pre-created
  p_default_table := false
);
--> statement-breakpoint

-- 7-year retention; drop (not detach) out-of-window partitions.
UPDATE partman.part_config
SET retention            = '7 years',
    retention_keep_table = false,
    premake              = 4,
    infinite_time_partitions = true
WHERE parent_table = 'core.audit_log';
--> statement-breakpoint

-- Materialise premake/forward partitions immediately on a fresh install.
CALL partman.run_maintenance_proc();
--> statement-breakpoint

-- Daily maintenance: create-ahead + drop-old in one pass.
-- NOTE: pg_cron objects live in the database named by the `cron.database_name`
-- server parameter (default `postgres`). If core.audit_log lives in a different
-- database, either set cron.database_name to the app DB or replace the call
-- below with cron.schedule_in_database(..., target_database := '<app-db>').
-- See infra/docs/audit-partman-setup.md.
SELECT cron.schedule(
  'audit-log-partman-maintenance',
  '0 3 * * *',                       -- 03:00 daily
  $$CALL partman.run_maintenance_proc()$$
);
