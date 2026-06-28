# Audit-log partitioning — pg_partman / pg_cron setup & verification

um27 makes `core.audit_log` born partitioned (`PARTITION BY RANGE
(created_datetime)`) and ULID-keyed, and stands up pg_partman + pg_cron so that
future monthly partitions are pre-created and partitions older than the 7-year
retention window are dropped automatically — with **zero manual partition DDL**.

The partitioned parent, the `core.generate_ulid()` default, the indexes/FK, and
the one bootstrap `audit_log_default` partition are created by the ordinary
migration `db/migrations/0001_audit.sql` (runnable as `app_migrate`). Everything
that needs elevated privileges — the extensions, `partman.create_parent`, the
retention policy, and the daily cron job — lives in
`db/bootstrap/audit-partman-setup.sql`, run once per environment by
`npm run db:setup-partman`. This mirrors the `bootstrap-db-roles.sql` pattern
(see `db-role-verification.md`).

## Server parameters (one-time, requires a restart)

Set on the Flexible Server before provisioning (Bicep:
`infra/bicep/modules/postgres.bicep` sets these as `configurations` child
resources):

1. **`azure.extensions`** allow-list must include `PG_PARTMAN`, `PG_CRON`, and
   `PGCRYPTO`. (`pgcrypto` supplies `gen_random_bytes()`, used by
   `core.generate_ulid()`; `gen_random_uuid()` is in core Postgres but
   `gen_random_bytes()` is not.) These are full-replacement values — keep every
   extension the server already allowed.
2. **`shared_preload_libraries`** must include `pg_cron` (the scheduler).
   `shared_preload_libraries` is a **static** parameter, so applying it
   **requires a one-time server restart** (accepted at um27 sign-off).
   `pg_partman_bgw` is intentionally **not** added — maintenance is driven by
   pg_cron's `run_maintenance_proc()` call, not the background worker.

## Provisioning order (once per environment)

1. `npm run db:migrate` (superuser/owner connection) — applies `0001_audit.sql`:
   creates `pgcrypto`, `core.generate_ulid()`, the partitioned `core.audit_log`,
   its indexes/FK, and the `audit_log_default` bootstrap partition.
2. Apply the server parameters above and **restart** the server.
3. `npm run db:setup-partman` — runs `db/bootstrap/audit-partman-setup.ts`,
   which reads `BOOTSTRAP_DATABASE_URL` (a superuser/owner connection string,
   never committed — **not** the app's `DATABASE_URL`) and executes the SQL:
   creates `pg_partman`/`pg_cron`, registers `core.audit_log` with
   `create_parent` (monthly range, premake 4), sets `retention = '7 years'`
   with `retention_keep_table = false`, materialises premake partitions via one
   `run_maintenance_proc()`, and schedules the daily `cron.schedule` job.

> **pg_partman major version.** The `create_parent` call in
> `audit-partman-setup.sql` uses the **v5.x** named-parameter signature. If the
> Azure image ships pg_partman v4.x, the signature and `p_type` values differ
> (`'native'`) — pin and verify the installed major before running.
>
> **pg_cron database scoping.** pg_cron objects live in the database named by
> the `cron.database_name` server parameter (default `postgres`). If
> `core.audit_log` lives in a different database, either set
> `cron.database_name` to the app DB, or replace the `cron.schedule(...)` call
> with `cron.schedule_in_database(..., target_database := '<app-db>')`.

## Verification

```sql
-- Generator returns a valid uuid; the 6-byte ms-timestamp prefix is
-- non-decreasing across calls (time-ordered at millisecond granularity).
SELECT core.generate_ulid();

-- audit_log is a partitioned table (relkind 'p') with a composite PK.
SELECT relkind FROM pg_class WHERE oid = 'core.audit_log'::regclass;   -- 'p'
SELECT conname FROM pg_constraint
WHERE conrelid = 'core.audit_log'::regclass AND contype = 'p';         -- audit_log_pkey

-- Premake: N future monthly partitions exist ahead of the current month.
SELECT inhrelid::regclass FROM pg_inherits
WHERE inhparent = 'core.audit_log'::regclass ORDER BY 1;

-- The daily maintenance cron job is registered and targets the right database.
SELECT jobname, schedule, database FROM cron.job
WHERE jobname = 'audit-log-partman-maintenance';

-- Partition routing: rows in different months land in differently-named
-- partitions; audit_log_default stays empty.
SELECT tableoid::regclass, count(*) FROM core.audit_log GROUP BY 1;

-- Append-only invariant (#11): app_runtime keeps INSERT-only on every partition.
SET ROLE app_runtime;
DELETE FROM core.audit_log WHERE 1=0;  -- ERROR: permission denied
RESET ROLE;
```

Retention is exercised by creating a partition for a >7-year-old month, running
`CALL partman.run_maintenance_proc()`, and confirming it is **dropped** (not
detached) while an in-window partition is retained.
