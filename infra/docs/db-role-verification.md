# DB role bootstrap — manual steps & verification

`db/migrations/0005_bootstrap_db_roles.sql` creates `app_runtime`/`app_migrate`
and grants/revokes their privileges, but deliberately contains **no
password** — see the migration file's header comment. Two manual,
never-committed steps complete the bootstrap.

## 1. Set passwords (once per environment, superuser/owner connection)

Generate two strong random passwords and run, directly against `psql` —
**never** add these to a source-controlled file:

```sql
ALTER ROLE app_runtime WITH PASSWORD '<generated>';
ALTER ROLE app_migrate WITH PASSWORD '<generated>';
```

## 2. Store the connection strings in Key Vault

Build the two `postgresql://` connection strings from those passwords and
store them as:

- `pg-connection-string-app` → consumed as `DATABASE_URL` by the running app
  (`app_runtime` role).
- `pg-connection-string-migrate` → consumed as `DATABASE_URL` by the
  migration Container Apps Job only (`app_migrate` role).

## Verification SQL

Run after the bootstrap migration and the password step above:

```sql
-- app_runtime cannot delete or update audit_log rows.
SET ROLE app_runtime;
DELETE FROM core.audit_log WHERE 1=0; -- ERROR: permission denied
UPDATE core.audit_log SET event_type='x' WHERE 1=0; -- ERROR: permission denied

-- app_runtime cannot run DDL.
CREATE TABLE core.forbidden (); -- ERROR: permission denied for schema core
RESET ROLE;

-- app_runtime can do normal app DML, incl. audit INSERT.
SET ROLE app_runtime;
SELECT count(*) FROM core.appuser; -- succeeds
INSERT INTO core.audit_log (event_type) VALUES ('TEST_EVENT'); -- succeeds
RESET ROLE;

-- app_migrate has the same audit_log constraint as app_runtime.
SET ROLE app_migrate;
DELETE FROM core.audit_log WHERE 1=0; -- ERROR: permission denied
RESET ROLE;
```

All of the above were verified against a throwaway local Docker Postgres 16
container during um30 implementation (migrated via `npm run db:migrate`
pointed at that container) — every assertion behaved as listed.
