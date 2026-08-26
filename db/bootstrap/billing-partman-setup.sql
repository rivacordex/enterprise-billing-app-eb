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

-- Preflight: fail loudly rather than emit broken DDL if pg_partman is absent
-- or pre-v5 (_risk-database-extension-version-drift.md §4.1; retrofitted here
-- from rm01-spec §Implementation §6, which introduced this guard). The
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

-- bm04-spec §Implementation §1-3. Second parent registration in this same
-- bootstrap file: billing.bill_run_account_stage (created by
-- 0028_bill_run_account_stage.sql). Same monthly/7-year-detach shape as
-- bill_run_account above — the stage table is the per-account, per-attempt
-- append-only audit surface (code-standards §1.10), so it shares the
-- volume/retention profile.
SELECT partman.create_parent(
  p_parent_table  := 'billing.bill_run_account_stage',
  p_control       := 'period_partition',
  p_interval      := '1 month',
  p_type          := 'range',
  p_premake       := 4,
  p_default_table := false
);
--> statement-breakpoint

UPDATE partman.part_config
SET retention            = '7 years',
    retention_keep_table = true,
    premake              = 4,
    infinite_time_partitions = true
WHERE parent_table = 'billing.bill_run_account_stage';
--> statement-breakpoint

-- bm05-spec §Implementation §1. Third parent registration in this same
-- bootstrap file: billing.customer_bill (created by
-- 0029_customer_bill.sql). Same monthly/7-year-detach shape as the two
-- parents above — the finalization latch (`ref_inv_document_id`) means a
-- posted bill's partition must never be dropped within the statutory window.
SELECT partman.create_parent(
  p_parent_table  := 'billing.customer_bill',
  p_control       := 'period_partition',
  p_interval      := '1 month',
  p_type          := 'range',
  p_premake       := 4,
  p_default_table := false
);
--> statement-breakpoint

UPDATE partman.part_config
SET retention            = '7 years',
    retention_keep_table = true,
    premake              = 4,
    infinite_time_partitions = true
WHERE parent_table = 'billing.customer_bill';
--> statement-breakpoint

-- bm06-spec §Implementation §1. Fourth parent registration in this same
-- bootstrap file: billing.customer_bill_tax_item (created by
-- 0030_customer_bill_tax_item.sql). Same monthly/7-year-detach shape as the
-- three parents above — a tax item is financially significant and shares its
-- parent bill's retention window (the composite FK means both partitions must
-- survive together within the statutory life).
SELECT partman.create_parent(
  p_parent_table  := 'billing.customer_bill_tax_item',
  p_control       := 'period_partition',
  p_interval      := '1 month',
  p_type          := 'range',
  p_premake       := 4,
  p_default_table := false
);
--> statement-breakpoint

UPDATE partman.part_config
SET retention            = '7 years',
    retention_keep_table = true,
    premake              = 4,
    infinite_time_partitions = true
WHERE parent_table = 'billing.customer_bill_tax_item';
--> statement-breakpoint

-- Materialise premake/forward partitions immediately on a fresh install
-- (covers all four parents registered above).
CALL partman.run_maintenance_proc();

-- No second cron job: the audit-log-partman-maintenance job
-- (audit-partman-setup.sql) already calls partman.run_maintenance_proc()
-- with no table argument, which sweeps every registered parent — including
-- every parent registered in this file, once their create_parent calls have
-- run. Do not schedule a second `cron.schedule_in_database` here.
