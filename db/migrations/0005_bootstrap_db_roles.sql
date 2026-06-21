-- um30-spec §"4. Least-privilege DB role bootstrap migration". One-time
-- bootstrap: creates `app_runtime`/`app_migrate` and grants/revokes their
-- privileges on the `core` schema. Idempotent via `DO` blocks (Postgres has
-- no `CREATE ROLE IF NOT EXISTS`, unlike `CREATE TABLE`/`CREATE INDEX`,
-- hence the spec's literal syntax doesn't run as-is — deviation, corrected
-- to valid Postgres). Run once under a superuser/owner connection during
-- initial provisioning — NOT by the automated `migrate` stage's
-- `app_migrate` role, which lacks rights to create roles. Deliberately
-- contains no password: see infra/docs/db-role-verification.md for the
-- manual `ALTER ROLE ... PASSWORD` follow-up (never committed to source
-- control). Only schema `core` exists today; repeat the GRANT/REVOKE block
-- for `product`/`customer`/`billing`/`accounting` as those schemas ship.
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
ALTER DEFAULT PRIVILEGES IN SCHEMA "core" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
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
ALTER DEFAULT PRIVILEGES IN SCHEMA "core" GRANT ALL ON TABLES TO app_migrate;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "core"."audit_log" FROM app_migrate;
