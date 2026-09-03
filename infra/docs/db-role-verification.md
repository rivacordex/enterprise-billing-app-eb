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
3. `npm run db:bootstrap-rating-roles` — runs
   `db/bootstrap/rating-db-roles.ts`, which reads the same
   `BOOTSTRAP_DATABASE_URL` and executes `db/bootstrap/rating-db-roles.sql`:
   creates the `rating_runtime` login role (CONNECTION LIMIT 20) and the
   complete rating/billing grant boundary (rm03-spec). Run it **after** step 2
   — it references the `app_runtime`/`app_migrate` roles that step creates and
   the `rating`/`product`/`ordering`/`inventory`/`billing` tables. Idempotent;
   the `ELSE ALTER ROLE` branch converges the connection limit on a re-run.
   **This step makes two platform-wide changes** — read the note below before
   running it in a shared environment.
3a. `npm run db:bootstrap-billrun-roles` — runs
   `db/bootstrap/billrun-db-roles.ts`, which reads the same
   `BOOTSTRAP_DATABASE_URL` and executes `db/bootstrap/billrun-db-roles.sql`:
   creates the `billrun_runtime` login role (CONNECTION LIMIT 20) — the DB
   identity the workflow-management component's bill run processor/
   distributor connect as — and the column-scoped grant surface that makes
   the phase-2 "two writers on `billing`" boundary a database privilege
   (bm14-spec; `billmgmt-architecture.md` §4, D14/D15). Run it **after**
   step 3 — its Step 0 fails loudly (`ORDERING: ...`) unless step 3's
   `REVOKE CONNECT ... FROM PUBLIC` has already run, since a `billrun_runtime`
   created before that revoke would inherit `CONNECT` via `PUBLIC` and the
   isolation intent would be silently false from the moment it exists.
   Idempotent; also revokes `app_runtime`'s `customer_bill_tax_item` write
   grant (phase 2 moves Taxation into the flow — the worker becomes its sole
   writer). This step has NO dependency on step 3b below — the bm14-spec's
   provisioning order is `roles → rating-roles → billrun-roles`, and `kestra`
   is not part of that chain at all.
3b. `npm run db:bootstrap-kestra-roles` — runs
   `db/bootstrap/kestra-db-roles.ts`, which reads the same
   `BOOTSTRAP_DATABASE_URL` and executes `db/bootstrap/kestra-db-roles.sql`:
   creates the **`kestra` database** and the `kestra_engine` login role
   (CONNECTION LIMIT 20 — placeholder, see `ratemgmt-progress-tracker.md`
   Open Questions) that rm04's Kestra engine connects as, then revokes
   `PUBLIC`'s default `CONNECT` on the new database and grants
   `kestra_engine` `CONNECT` + `CREATE` explicitly (rm03-spec §Implementation
   Step 9a; rm04-spec Depends-on, Inv #18's reverse direction — `kestra`
   must be as unreachable from `rating_runtime`/`app_runtime`/`app_migrate`
   as billing is from `kestra_engine`). Run it **after** step 3 — creating
   `kestra_engine` before step 3's `REVOKE CONNECT ... FROM PUBLIC` on the
   billing database would let it inherit billing access through `PUBLIC`
   before the revoke ever runs. `CREATE DATABASE` cannot be made idempotent
   in SQL (it cannot run inside a transaction block, so it cannot sit in an
   `IF NOT EXISTS` guard); the runner instead catches Postgres error code
   `42P04` (duplicate_database) and treats a second run as a no-op.
4. Set passwords + store connection strings in Key Vault (steps below).

After provisioning, every subsequent deploy's `migrate` Container Apps Job
runs as `app_migrate` via `pg-connection-string-migrate`, applying ordinary
schema migrations only; new tables it creates inherit the default privileges
configured in step 2.

### Platform changes made by `db:bootstrap-rating-roles` (read before running)

`db/bootstrap/rating-db-roles.sql` does two things that reach **beyond the
`rating` schema** and affect every role on the target database. They close
holes rating merely surfaced (rm03-spec D6/D7, escalations E1/E2):

- **`REVOKE CONNECT ON DATABASE <billing_db> FROM PUBLIC`.** A `NULL` `datacl`
  means the built-in default is in force, and that default lets `PUBLIC`
  connect — so any future login role reaches the billing database with no
  explicit grant. This is the precondition for Inv #18 (rm04's Kestra engine
  role holding no `CONNECT`). `app_runtime` and `app_migrate` already hold
  **explicit** `CONNECT` (granted in step 2) and are unaffected; `rating_runtime`
  is granted it explicitly here. **Confirm before running** that no other role
  reaches this database only through `PUBLIC` — check `pg_roles` against the
  connection strings in use. Superusers and the database owner bypass the ACL.
- **`REVOKE EXECUTE ... FROM PUBLIC`** on the four `billing` `SECURITY DEFINER`
  pgledger functions (`pgledger_create_account`, `pgledger_create_transfer`,
  and both `pgledger_create_transfers` overloads). `PUBLIC` holds `EXECUTE` by
  default, so **any** login role could post ledger transfers through the
  definer wrappers regardless of table grants — this would make Inv #1 false on
  day one. `app_runtime` keeps its **explicit** `EXECUTE` grant
  (`bootstrap-db-roles.sql`) and is unaffected; `rating_runtime` is granted
  nothing on them. This is a platform/billing defect that predates rating
  (escalation E1) — raise it against the billing module so the revoke is owned
  where the functions live and the next `SECURITY DEFINER` function ships with it.

## 1. Set passwords (once per environment, superuser/owner connection)

Generate two strong random passwords and run, directly against `psql` —
**never** add these to a source-controlled file:

```sql
ALTER ROLE app_runtime WITH PASSWORD '<generated>';
ALTER ROLE app_migrate WITH PASSWORD '<generated>';
```

`rating-db-roles.sql` likewise contains **no password**. After
`db:bootstrap-rating-roles`, set one for `rating_runtime` the same way —
generate a third strong random password and run it directly against `psql`,
**never** in a source-controlled file. The value goes to Key Vault (rm04):

```sql
ALTER ROLE rating_runtime WITH PASSWORD '<generated>';
```

`billrun-db-roles.sql` likewise contains **no password**. After
`db:bootstrap-billrun-roles`, set one for `billrun_runtime` the same way —
generate a fourth strong random password and run it directly against `psql`,
**never** in a source-controlled file. This is the phase-2 credential's third
member (after the app bearer token and the outbound engine Basic-Auth — see
`billmgmt-architecture.md` §4 / plan §9). The value goes to Key Vault and is
consumed as `BILLRUN_RUNTIME_DATABASE_URL` (bm14-spec):

```sql
ALTER ROLE billrun_runtime WITH PASSWORD '<generated>';
```

`kestra-db-roles.sql` likewise contains **no password**. After
`db:bootstrap-kestra-roles`, set one for `kestra_engine` the same way —
generate a fifth strong random password and run it directly against `psql`,
**never** in a source-controlled file. The value goes to Key Vault as the
`kestra_engine` D5 credential (rm04):

```sql
ALTER ROLE kestra_engine WITH PASSWORD '<generated>';
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

## Verification SQL — the `kestra` database boundary (rm03a / rm04, Inv #18 reverse direction)

Run after `db:bootstrap-kestra-roles` and the `kestra_engine` password step
above, connecting to the **billing** database (database-level ACL checks work
from any database in the cluster):

```sql
-- rating_runtime, app_runtime and app_migrate cannot reach kestra — none
-- holds an explicit CONNECT and PUBLIC's default was revoked.
SELECT has_database_privilege('rating_runtime', 'kestra', 'CONNECT'); -- false
SELECT has_database_privilege('app_runtime', 'kestra', 'CONNECT');    -- false
SELECT has_database_privilege('app_migrate', 'kestra', 'CONNECT');    -- false

-- kestra_engine holds both CONNECT and CREATE on kestra (the latter for
-- Kestra's own startup schema migrations, rm04-spec D7) but nothing on
-- the billing database — the mirror image of Inv #18's stated direction.
SELECT has_database_privilege('kestra_engine', 'kestra', 'CONNECT'); -- true
SELECT has_database_privilege('kestra_engine', 'kestra', 'CREATE');  -- true
SELECT has_database_privilege('kestra_engine', current_database(), 'CONNECT'); -- false
```

Not yet verified against a live cluster in this session — see
`ratemgmt-progress-tracker.md`.

## Verification SQL — the `billrun_runtime` two-writer boundary (bm14, D14/D15)

Run after `db:bootstrap-billrun-roles` and the `billrun_runtime` password step
above, connecting to the **billing** database:

```sql
-- billrun_runtime can write the customer_bill trial columns, but not the
-- three posting stamps (column-scoped, Step 5).
SELECT has_column_privilege('billrun_runtime', 'billing.customer_bill', 'state', 'UPDATE');               -- true
SELECT has_column_privilege('billrun_runtime', 'billing.customer_bill', 'ref_inv_document_id', 'UPDATE'); -- false
SELECT has_column_privilege('billrun_runtime', 'billing.customer_bill', 'posted_attempt', 'INSERT');      -- false

-- billrun_runtime has no table-level DELETE on customer_bill (T10) — deletes
-- go through the scoped SECURITY DEFINER function only.
SELECT has_table_privilege('billrun_runtime', 'billing.customer_bill', 'DELETE'); -- false
SELECT has_function_privilege('billrun_runtime', 'billing.billrun_delete_trial_bill(text, text)', 'EXECUTE'); -- true

-- app_runtime lost its customer_bill_tax_item write grant (Step 6a) — SELECT
-- only, billrun_runtime is now the sole writer.
SELECT has_table_privilege('app_runtime', 'billing.customer_bill_tax_item', 'INSERT'); -- false
SELECT has_table_privilege('app_runtime', 'billing.customer_bill_tax_item', 'SELECT'); -- true

-- billrun_runtime holds no write on run-state or billing.document (Step 9).
SELECT has_table_privilege('billrun_runtime', 'billing.bill_run', 'UPDATE');      -- false
SELECT has_table_privilege('billrun_runtime', 'billing.document', 'INSERT');      -- false

-- billrun_runtime cannot reach kestra, and holds billing CONNECT only via its
-- explicit grant.
SELECT has_database_privilege('billrun_runtime', 'kestra', 'CONNECT');                        -- false
SELECT has_database_privilege('billrun_runtime', current_database(), 'CONNECT');              -- true
SELECT rolconnlimit FROM pg_roles WHERE rolname = 'billrun_runtime';                           -- 20
```

Not yet verified against a live cluster in this session — see
`billmgmt-progress-tracker.md`.

Not yet verified against a live cluster in this session — see
`ratemgmt-progress-tracker.md`.
