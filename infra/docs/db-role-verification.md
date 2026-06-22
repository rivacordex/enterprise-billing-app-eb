# DB role bootstrap — manual steps & verification

`db/bootstrap/bootstrap-db-roles.sql` creates `app_runtime`/`app_migrate`
and grants/revokes their privileges, but deliberately contains **no
password** — see the script's header comment.

## Provisioning order (once per environment)

This script is **not** a Drizzle migration: creating roles needs a
superuser/owner connection, while the automated `migrate` stage runs as the
least-privilege `app_migrate` role this script itself creates — a role-creation
step therefore cannot live in the migration sequence that stage iterates.

The bootstrap grants/revokes privileges on tables that must already exist
(`core.audit_log`, `ALL TABLES IN SCHEMA core`), so it runs **after** the
schema is created. The whole provisioning sequence is run once, by a
human/operator, on a single superuser/owner connection:

1. `npm run db:migrate` pointed at the **superuser/owner** connection — creates
   the `core` schema and all tables. They are owned by that superuser/owner,
   **not** by `app_migrate`; this matters because the audit-log REVOKEs in
   step 2 are only effective against non-owner roles (a table owner always
   keeps every privilege regardless of `REVOKE`).
2. `npm run db:bootstrap-roles` — runs `db/bootstrap/bootstrap-db-roles.ts`,
   which reads `BOOTSTRAP_DATABASE_URL` (a superuser/owner connection string,
   never committed) and executes the SQL: creates the two roles, grants/revokes
   on the now-existing tables, and sets `ALTER DEFAULT PRIVILEGES FOR ROLE
app_migrate` so future tables `app_migrate` creates auto-grant to
   `app_runtime`. Idempotent.
3. Set passwords + store connection strings in Key Vault (steps below).

After provisioning, every subsequent deploy's `migrate` Container Apps Job
runs as `app_migrate` via `pg-connection-string-migrate`, applying ordinary
schema migrations only; new tables it creates inherit the default privileges
configured in step 2.

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
container during um30 implementation — every assertion behaved as listed.
Note the container connected as the `postgres` superuser, which is why role
creation succeeded there; against a least-privilege database the bootstrap
**must** run via step 1 above on a superuser/owner connection, never through
the `app_migrate`-scoped `migrate` stage.
