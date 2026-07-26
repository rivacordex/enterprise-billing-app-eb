-- um30-spec §"4. Least-privilege DB role bootstrap migration". One-time
-- bootstrap: creates `app_runtime`/`app_migrate` and grants/revokes their
-- privileges on the `core` schema.
--
-- NOT a Drizzle migration. It lives outside `db/migrations/` on purpose:
-- creating roles requires a superuser/owner connection (CREATEROLE), whereas
-- the automated `migrate` stage runs `db/migrate.ts` as the least-privilege
-- `app_migrate` role — which this script itself creates, and which has no
-- right to create roles. A role-bootstrap step therefore cannot sit in the
-- migration sequence the migrate stage iterates (chicken-and-egg). The
-- grants/revokes below also reference tables that must already exist, so run
-- it once per environment during provisioning, AFTER the initial
-- superuser/owner `db:migrate` has created the schema — via
-- `npm run db:bootstrap-roles` (a superuser/owner connection string in
-- `BOOTSTRAP_DATABASE_URL`) or directly with `psql`. See the provisioning
-- order in infra/docs/db-role-verification.md.
--
-- Idempotent via `DO` blocks (Postgres has no `CREATE ROLE IF NOT EXISTS`,
-- unlike `CREATE TABLE`/`CREATE INDEX`). Deliberately contains no password:
-- see infra/docs/db-role-verification.md for the manual `ALTER ROLE ...
-- PASSWORD` follow-up (never committed to source control). `core`,
-- `product`, and `customer` are covered below; repeat the GRANT/REVOKE
-- block for `billing`/`accounting` as those schemas ship.
--
-- The statement-breakpoint marker lines below let `db/bootstrap/
-- bootstrap-db-roles.ts` split the file into individual statements; they are
-- SQL line comments, so running the whole file through `psql` works too.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime WITH LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_migrate') THEN
    CREATE ROLE app_migrate WITH LOGIN;
  END IF;
END
$$;
--> statement-breakpoint
-- app_runtime: domain DML + INSERT-only on audit_log, no DDL.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_runtime', current_database());
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "core" TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "core" TO app_runtime;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "core"."audit_log" FROM app_runtime;
--> statement-breakpoint
-- Default privileges must be attached to the role that creates future
-- tables (app_migrate, which runs the automated migrate stage), NOT to the
-- superuser/owner running this one-time bootstrap — otherwise they would
-- never apply to app_migrate-created tables. Hence FOR ROLE app_migrate.
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate IN SCHEMA "core" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
--> statement-breakpoint
-- app_migrate: full DDL + DML, same audit_log constraint as app_runtime.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_migrate', current_database());
  EXECUTE format('GRANT CREATE ON DATABASE %I TO app_migrate', current_database());
END
$$;
--> statement-breakpoint
GRANT ALL ON SCHEMA "core" TO app_migrate;
--> statement-breakpoint
GRANT ALL ON ALL TABLES IN SCHEMA "core" TO app_migrate;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate IN SCHEMA "core" GRANT ALL ON TABLES TO app_migrate;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "core"."audit_log" FROM app_migrate;
--> statement-breakpoint
-- app_migrate's drizzle-kit migration bookkeeping lives in the `drizzle`
-- schema (drizzle.__drizzle_migrations). When the initial migrate runs under
-- the superuser/owner (infra/docs/db-role-verification.md step 1), that schema
-- and its table are owner-owned, so app_migrate — which the automated migrate
-- stage runs as — gets "permission denied" on the migrator's first statement
-- (CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations). Grant it the
-- access the migrator needs: USAGE/CREATE on the schema, DML on the bookkeeping
-- table, and USAGE on its SERIAL sequence. Idempotent; the `drizzle` schema
-- already exists by the time this script runs (after step 1's migrate).
GRANT USAGE, CREATE ON SCHEMA "drizzle" TO app_migrate;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "drizzle" TO app_migrate;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "drizzle" TO app_migrate;
--> statement-breakpoint
-- `product` schema (pm01+): same app_runtime/app_migrate split as `core`,
-- plus sequence grants — product_offering/product_specifications/
-- product_offering_price ID columns default to nextval(...), so app_runtime
-- needs USAGE on those sequences to satisfy plain INSERTs. No audit_log-style
-- table exists here, so no extra REVOKE.
GRANT USAGE ON SCHEMA "product" TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "product" TO app_runtime;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "product" TO app_runtime;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate IN SCHEMA "product" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate IN SCHEMA "product" GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;
--> statement-breakpoint
GRANT ALL ON SCHEMA "product" TO app_migrate;
--> statement-breakpoint
GRANT ALL ON ALL TABLES IN SCHEMA "product" TO app_migrate;
--> statement-breakpoint
GRANT ALL ON ALL SEQUENCES IN SCHEMA "product" TO app_migrate;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate IN SCHEMA "product" GRANT ALL ON TABLES TO app_migrate;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate IN SCHEMA "product" GRANT ALL ON SEQUENCES TO app_migrate;
--> statement-breakpoint
-- `customer` schema (cm01+): same app_runtime/app_migrate split as
-- `product` — organization/party_role/contact_medium ID columns default to
-- nextval(...), so app_runtime needs USAGE on those sequences to satisfy
-- plain INSERTs. No audit_log-style table exists here, so no extra REVOKE.
GRANT USAGE ON SCHEMA "customer" TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "customer" TO app_runtime;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "customer" TO app_runtime;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate IN SCHEMA "customer" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate IN SCHEMA "customer" GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;
--> statement-breakpoint
GRANT ALL ON SCHEMA "customer" TO app_migrate;
--> statement-breakpoint
GRANT ALL ON ALL TABLES IN SCHEMA "customer" TO app_migrate;
--> statement-breakpoint
GRANT ALL ON ALL SEQUENCES IN SCHEMA "customer" TO app_migrate;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate IN SCHEMA "customer" GRANT ALL ON TABLES TO app_migrate;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate IN SCHEMA "customer" GRANT ALL ON SEQUENCES TO app_migrate;
