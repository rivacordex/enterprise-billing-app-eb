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
`billmgmt-architecture.md` §4 / plan §9). It is deployed with the **same split
shape as `rating_runtime`** (bare password + separate connection coordinates,
NOT a full connection string): the password goes to Key Vault as the
`billrun-runtime-db-password` secret, exposed to the engine as
`SECRET_BILLRUN_RUNTIME_PASSWORD`, and the flows build their own connection from
the non-secret `BILLRUN_DB_HOST/PORT/NAME/USER` env vars (bm38 — the
`hostsBillrunNamespace` branch in `workflow-engine-container-app.bicep`; see §2
below for the secret name + consumer mapping). Under the collapsed topology the
consumer is the single `workflow-engine` instance that hosts the `billrun`
namespace; under split-by-module it is the `workflow-engine-billrun` instance.

The flow reads the password via `PGPASSWORD` (`bill_run_processing.yml`), not
by embedding it in a `postgresql://` URL, so URL-escaping is not required — but
still prefer a **URI-safe alphabet** (letters, digits, `-._~`) so the same value
drops cleanly into any hand-built connection string (e.g. the disposable/CI
test DB) without an unescaped `@`/`:`/`/`/`?`/`#`/`%` corrupting it:

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

Build the two `postgresql://` connection strings from those passwords —
requiring authenticated TLS (`sslmode=verify-full`, or the client-side
equivalent) so a client can never silently fall back to an unencrypted
connection — and store them as:

- `pg-connection-string-app` → consumed as `DATABASE_URL` by the running app
  (`app_runtime` role).
- `pg-connection-string-migrate` → consumed as `DATABASE_URL` by the
  migration Container Apps Job only (`app_migrate` role).

`rating_runtime`, `kestra_engine` and `billrun_runtime` are deployed
differently: their connection details are split into separate
`*_DB_HOST`/`PORT`/`NAME`/`USER` env vars plus a **bare-password** Key Vault
secret (never a full `postgresql://` URL). The engine's flows/worker build the
connection themselves from the coordinates and read the password from the
`SECRET_*` env var:

- `rating-runtime-db-password` → `SECRET_RATING_RUNTIME_PASSWORD` (the rating
  worker's `db.py` reads it + `RATING_DB_HOST/PORT/NAME/USER`).
- `kestra-engine-db-password` → the Kestra datasource password (`KESTRA_DATASOURCES_POSTGRES_*`).
- `billrun-runtime-db-password` → `SECRET_BILLRUN_RUNTIME_PASSWORD`, consumed by
  the shared **`workflow-engine` Container App** (bm38). The
  `hostsBillrunNamespace` param in `workflow-engine-container-app.bicep` gates
  the secret ref + the `BILLRUN_DB_HOST/PORT/NAME/USER` env vars onto the
  billrun-hosting engine only (the collapsed instance, or the
  `workflow-engine-billrun` split instance); a rating-only engine gets neither.
  `BILLRUN_DB_HOST` is the Flexible Server FQDN (shared with the `kestra` DB —
  only the DB **name** differs), `BILLRUN_DB_NAME` is `enterprise_billing`. The
  flows connect via `psql`/`PGPASSWORD`. **Before production cutover the billrun
  DB hop MUST enforce authenticated TLS:** set `PGSSLMODE=verify-full` plus
  `PGSSLROOTCERT` pointing at the trusted CA bundle (the Azure PG root CA) as
  engine container env — libpq honours both automatically, so no flow change is
  needed — so the connection authenticates the server and can never silently
  fall back to plaintext. Provisioned as a cutover step (see "Production
  cutover" below), not a default in this module. (The separate rating-worker
  configuration is out of scope here and left unchanged.)

All three are `see workflow-engine-container-app.bicep`.

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
-- explicit grant — has_database_privilege alone can't distinguish "explicit
-- grant" from "inherited through PUBLIC or role membership", so also check
-- the ACL directly and confirm no inherited membership exists.
SELECT has_database_privilege('billrun_runtime', 'kestra', 'CONNECT');                        -- false
SELECT has_database_privilege('billrun_runtime', current_database(), 'CONNECT');              -- true
SELECT datacl FROM pg_database WHERE datname = current_database();
  -- expect an aclitem for billrun_runtime containing 'c', e.g. billrun_runtime=Cc/<owner>,
  -- and no PUBLIC entry with 'c' (PUBLIC's default was revoked by rating-db-roles.sql)
SELECT count(*) FROM pg_auth_members m
  JOIN pg_roles r ON r.oid = m.member
  WHERE r.rolname = 'billrun_runtime';                                                        -- 0 (no role membership to inherit through)
SELECT rolconnlimit FROM pg_roles WHERE rolname = 'billrun_runtime';                           -- 20
```

Not yet verified against a live cluster in this session — see
`billmgmt-progress-tracker.md`.

## Production cutover — the `billrun` module (bm38)

The bill-run deploy path is **deployable and reviewable, with the actual cloud
cutover gated**. The shared `workflow-engine` bicep, its `billrun` secret wiring
(`billrun-runtime-db-password`, `hostsBillrunNamespace`), the SFTP shape
(`enableSftpDistribution`), and the pipeline stages that deploy flows / run the
live smoke all exist — but every deploy flag is **off by default** and the real
engine/DB/SFTP endpoints are provisioned out-of-band. This section is the
order-of-operations runbook for the operator who performs the cutover; nothing
here runs automatically.

**Topology.** Prod runs the **collapsed** topology (`prod.bicepparam`:
`topology = 'collapsed'`): ONE `workflow-engine` Container App hosts BOTH the
`rating` and `billrun` namespaces — there is **no** separate processor or
distributor container. The deployed processing/distribution flows ARE the
repo's `workflow-management/flows/bill-run-processor/local-dev` and
`bill-run-distributor/local-dev` flows (there is no separate
workflow-management flow repo); `deploy_workflow_flows` pushes both to the
`billrun` namespace on that shared engine.

### Order of operations

1. **Provision the DB role + password.** Run the provisioning sequence above
   (`db:bootstrap-roles → …-rating-roles → …-billrun-roles`) on the
   superuser/owner connection, then `ALTER ROLE billrun_runtime WITH PASSWORD`
   from a **URI-safe alphabet** (§1) — the flow reads it via `PGPASSWORD`, but a
   URI-safe value also drops cleanly into any hand-built connection string.
   **After pulling grant-file changes, re-run
   `db:bootstrap-billrun-roles`** — it is idempotent, and the
   `billrun_status_guard` it installs now permits the `REJECTED → BILL_DRAFT`
   re-claim; a stale bootstrap 403s the reject-then-reprocess path.
2. **Store the Key Vault secrets (out-of-band, never in git):**
   - `billrun-runtime-db-password` — the BARE `billrun_runtime` password (§2),
     exposed to the `workflow-engine` container as
     `SECRET_BILLRUN_RUNTIME_PASSWORD` via `hostsBillrunNamespace` (the
     connection coordinates `BILLRUN_DB_HOST/PORT/NAME/USER` are non-secret env,
     wired in the bicep — `BILLRUN_DB_HOST` = the Flexible Server FQDN). Same
     split shape as `rating-runtime-db-password`; NOT a full connection string.
   - `billrun-engine-url` — `https://<engine-fqdn>` the app calls
     (`BILLRUN_ENGINE_URL`).
   - `billrun-engine-auth` — the app→engine Basic-Auth `username:password`
     (`BILLRUN_ENGINE_AUTH`). **Its username half MUST be
     `workflow-ops@billing.ops`** — the coupled triple: (1) the engine's
     `KESTRA_SERVER_BASIC_AUTH_USERNAME` in
     `workflow-engine-container-app.bicep`, (2) `deploy_workflow_flows`'s
     `--user` in `azure-pipelines.yml`, and (3) this out-of-band secret. (1)
     and (2) are in git and change together; (3) is here. Rotate all three in
     lockstep — a mismatch 401s every app→engine call (trigger / check-status /
     cancel / reconcile) after deploy.
   - (SFTP only, see step 5) `sftp-private-key` / `sftp-known-hosts` — the PEM
     private key and the pinned host key(s), **base64-encoded** (Kestra's OSS
     env-secret backend base64-decodes `SECRET_<NAME>`), with host-key
     verification ON (never `StrictHostKeyChecking=no`).
3. **Deploy the engine.** Set `deployWorkflowEngine = true` (main.bicep) and
   apply. Under collapsed topology `hostsBillrunNamespace` is already `true`
   for this instance, so the `billrun-runtime-db-password` secret ref +
   `SECRET_BILLRUN_RUNTIME_PASSWORD` / `BILLRUN_DB_*` env vars deploy with it;
   the loopback distribution sink (`enableLocalDistributionSink`, default true)
   mounts at `/distribution`. Also set `PGSSLMODE=verify-full` + `PGSSLROOTCERT`
   (trusted CA bundle) on the engine so the billrun DB hop authenticates the
   server and cannot fall back to plaintext (§2).
4. **Deploy the flows + run the smoke.** Queue the pipeline with
   `deployRatingFlows = true` (merge-to-main only) so `deploy_workflow_flows`
   pushes `rating-engine → rating`, `bill-run-processor/local-dev → billrun`,
   and `bill-run-distributor/local-dev → billrun`. Then queue with
   `runBillrunLiveKestraSmoke = true` (reads `pg-connection-string-app`,
   `billrun-engine-url`, `billrun-engine-auth`; requires `db:seed-sample` to
   have been run out-of-band against that database) to drive the full
   `SCHEDULED → COMPLETED` journey against the real engine.
5. **Flip SFTP only when a real endpoint exists.** The default distribution
   target is `loopback` (writes to the mounted `/distribution` sink — no SSH,
   no keys). Turn on real SFTP by setting `enableSftpDistribution = true` +
   `sftpHost=<endpoint>` (main.bicep flips BOTH the engine's SFTP wiring and
   the app's `BILLRUN_DISTRIBUTION_TARGETS='sftp'` from the one knob, so they
   can never split-brain) — but only once `sftp-private-key`/`sftp-known-hosts`
   are provisioned (step 2), or the deploy fails closed on the missing secret
   reference.

### Taxation — `0.00` interim (recorded)

Taxation is a ratified **no-op** this phase: the processing flow's `taxation`
stage computes nothing and `customer_bill.tax_total = 0.00`
(`total_amount = subtotal`). This is deliberate, not a cutover gap — see
`billmgmt-known-issues.md` §10 and the flow's no-op `taxation` stage. Real
jurisdiction/category tax rules are a later unit; the cutover does not wait on
them.

Not yet verified against a live cluster in this session — see
`billmgmt-progress-tracker.md`.
