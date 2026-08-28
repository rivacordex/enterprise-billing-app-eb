-- rm03a (specs/rm03-rating-runtime-role-grants.md §Implementation Step 9a;
-- specs/rm04-kestra-deployment-and-local-dev.md Depends-on). Creates the
-- `kestra` database and the `kestra_engine` login role that rm04's Kestra
-- engine connects as, and closes the CONNECT hole on the new database the
-- same way rating-db-roles.sql closed it on the billing database.
--
-- MUST run AFTER db:bootstrap-rating-roles's Step 2
-- (`REVOKE CONNECT ON DATABASE <billing> FROM PUBLIC`). Created before that,
-- `kestra_engine` would briefly inherit access to the billing database
-- through PUBLIC and Inv #18 would be false from the moment it exists —
-- silently, because nothing about the role itself would look wrong.
--
-- NOT a Drizzle migration: CREATE DATABASE/CREATE ROLE need CREATEDB/
-- CREATEROLE, which `app_migrate` — the role the automated `migrate` stage
-- runs as — does not hold. Run once per environment via
-- `npm run db:bootstrap-kestra-roles` (BOOTSTRAP_DATABASE_URL, the same
-- superuser/owner connection used for db:bootstrap-rating-roles) or directly
-- with `psql`. See the provisioning order in infra/docs/db-role-verification.md.
--
-- GRANT/REVOKE ON DATABASE and CREATE ROLE act on cluster-shared catalogs
-- (pg_database, pg_authid), not on the connected database's contents, so
-- every statement here runs from the existing billing-database connection —
-- no second connection to `kestra` is needed for THIS script. (rm04's engine
-- itself connects to `kestra` directly to run its own schema migrations,
-- using the CREATE privilege granted in Step 3 below.)
--
-- Idempotent. Deliberately contains NO password — see
-- infra/docs/db-role-verification.md for the manual
-- `ALTER ROLE kestra_engine PASSWORD` follow-up (never committed). The
-- statement-breakpoint marker lines let db/bootstrap/kestra-db-roles.ts split
-- the file into individual statements; they are SQL line comments, so running
-- the whole file through `psql` works too.

-- Step 1 — the kestra database. CREATE DATABASE cannot run inside a
-- transaction block (a hard Postgres restriction — this is why it cannot be
-- wrapped in a DO $$ ... $$ block like Step 2 below), so idempotency for
-- THIS ONE statement is handled by the runner (kestra-db-roles.ts), which
-- catches Postgres error code 42P04 (duplicate_database) and treats it as
-- already-converged rather than a failure. Direct `psql` re-runs must skip
-- this statement by hand if the database already exists.
CREATE DATABASE "kestra";
--> statement-breakpoint

-- Step 2 — the role (idempotent). The ELSE branch converges the connection
-- limit on a re-run, mirroring rating-db-roles.sql Step 1. The specific limit
-- (20, matching rating_runtime) is a placeholder pending an operator decision
-- sized to the engine's actual worker/replica count — see
-- ratemgmt-progress-tracker.md Open Questions.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'kestra_engine') THEN
    CREATE ROLE kestra_engine WITH LOGIN CONNECTION LIMIT 20
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE kestra_engine WITH LOGIN CONNECTION LIMIT 20
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint

-- Step 3 — close the PUBLIC CONNECT default on `kestra` (mirror image of
-- rating-db-roles.sql Step 2), then grant kestra_engine CONNECT + CREATE
-- explicitly. A NULL datacl on a freshly created database means the built-in
-- default is in force, and that default includes CONNECT for PUBLIC — so
-- without this revoke, `rating_runtime`, `app_runtime` and `app_migrate`
-- would all reach the `kestra` database through PUBLIC with no explicit
-- grant, and Inv #18 (stated one-directionally as "kestra_engine holds no
-- CONNECT on billing") would leave the reverse hole wide open. None of those
-- three roles is granted CONNECT here, so none can reach `kestra` after this
-- statement runs. CREATE (not just CONNECT) is required because Kestra runs
-- its own schema migrations on startup (rm04-spec D7) — it must be able to
-- create objects inside its own database.
REVOKE CONNECT ON DATABASE "kestra" FROM PUBLIC;
--> statement-breakpoint
GRANT CONNECT, CREATE ON DATABASE "kestra" TO kestra_engine;
