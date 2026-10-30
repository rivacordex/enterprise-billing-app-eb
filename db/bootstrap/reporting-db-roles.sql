-- rpt01-spec §Implementation §1 (D1/D2). Creates the `reporting_runtime` login
-- role — the DB identity the Reporting Management flows (function 4, namespace
-- `reporting`) read as — and its SELECT-only grant surface. Reporting never
-- writes the database (rptmgmt-architecture.md Inv 1); the boundary is these
-- grants, not code.
--
-- NOT a Drizzle migration: creating a role needs CREATEROLE, which app_migrate
-- does not hold. Run once per environment during provisioning, AFTER
-- db:bootstrap-roles, db:bootstrap-rating-roles AND db:bootstrap-billrun-roles
-- (order: roles -> rating-roles -> billrun-roles -> reporting-roles, then
-- kestra-roles as today). Rating's Step 2 REVOKE CONNECT … FROM PUBLIC must
-- precede this role's creation, or it inherits CONNECT via PUBLIC (Step 0).
-- Via `npm run db:bootstrap-reporting-roles` (BOOTSTRAP_DATABASE_URL = a
-- superuser/owner connection) or psql.
-- Contains NO password: see infra/docs/db-role-verification.md step 3c for the
-- manual ALTER ROLE … PASSWORD follow-up (Key Vault
-- `reporting-runtime-db-password`, never committed).

-- Step 0 — deploy-ordering precondition (billrun-db-roles.sql Step 0
-- precedent). Fail closed unless rating's REVOKE CONNECT ON DATABASE ... FROM
-- PUBLIC has already run: if PUBLIC still holds CONNECT on this database,
-- reporting_runtime would inherit it and the isolation intent is silently
-- false from creation.
DO $$
BEGIN
  IF has_database_privilege('public', current_database(), 'CONNECT') THEN
    RAISE EXCEPTION 'ORDERING: run rating-db-roles.sql (its REVOKE CONNECT ... FROM PUBLIC) before reporting-db-roles.sql (rpt01 D1)';
  END IF;
END
$$;
--> statement-breakpoint

-- Step 1 — the role (idempotent, convergent ELSE branch strips attribute
-- drift back to least privilege — a reporting_runtime that drifted to
-- SUPERUSER would bypass every ACL below — and fails closed on membership/
-- ownership drift, which ALTER ROLE cannot fix).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'reporting_runtime') THEN
    CREATE ROLE reporting_runtime WITH LOGIN
      NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS
      CONNECTION LIMIT 10;
  ELSE
    -- Fail closed on drift ALTER ROLE cannot fix: membership in another role
    -- or ownership of an object would both survive the attribute reset below
    -- and could bypass every ACL this file grants.
    IF EXISTS (
      SELECT FROM pg_catalog.pg_auth_members m
      JOIN pg_catalog.pg_roles r ON r.oid = m.member
      WHERE r.rolname = 'reporting_runtime'
    ) THEN
      RAISE EXCEPTION 'DRIFT: reporting_runtime is a member of another role — reconcile membership drift before provisioning (rpt01 D1)';
    END IF;
    IF EXISTS (
      SELECT FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
      WHERE r.rolname = 'reporting_runtime'
    ) THEN
      RAISE EXCEPTION 'DRIFT: reporting_runtime owns one or more objects — reconcile ownership drift before provisioning (rpt01 D1)';
    END IF;

    ALTER ROLE reporting_runtime WITH LOGIN
      NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS
      CONNECTION LIMIT 10;
  END IF;
END
$$;
--> statement-breakpoint

-- Step 2 — every session starts read-only, before the runtime's own
-- `SET TRANSACTION … READ ONLY` (common/db.py). Defence in depth for Inv 1;
-- the grants below remain the guarantee (a session can turn this off, it
-- cannot grant itself a write).
ALTER ROLE reporting_runtime SET default_transaction_read_only = on;
--> statement-breakpoint

-- Step 3 — explicit CONNECT (PUBLIC's default was already revoked by
-- rating-db-roles.sql Step 2, so this role must be granted it explicitly).
-- Nothing on the `kestra` database: kestra-db-roles.sql revokes PUBLIC's
-- CONNECT there and no grant is made here (D2).
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO reporting_runtime', current_database());
END
$$;
--> statement-breakpoint

-- Step 4 — schema USAGE (confers no table access on its own). Only the three
-- schemas Parts A–C read; `rating` arrives with rpt08 (IC23).
GRANT USAGE ON SCHEMA "billing"  TO reporting_runtime;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "customer" TO reporting_runtime;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "product"  TO reporting_runtime;
--> statement-breakpoint

-- Step 5 — SELECT on exactly the tables Parts A–C read (SR39, MO19, PC24),
-- enumerated per table (rptmgmt-code-standards §7): never ON ALL TABLES, no
-- ALTER DEFAULT PRIVILEGES, no sequence USAGE, no EXECUTE. The pgledger
-- objects in SR39 are deferred to rpt03 (D2); rpt08/rpt09 add theirs.
GRANT SELECT ON TABLE
  "billing"."customer_bill",
  "billing"."document",
  "billing"."document_line",
  "billing"."billing_account",
  "billing"."financial_account",
  "billing"."ledger_binding"
TO reporting_runtime;
--> statement-breakpoint
GRANT SELECT ON TABLE
  "customer"."party_role"
TO reporting_runtime;
--> statement-breakpoint
GRANT SELECT ON TABLE
  "product"."ratecard_version",
  "product"."ratecard_ran_usage_lkp"
TO reporting_runtime;
--> statement-breakpoint

-- Step 6 — explicit REVOKEs, for the record (D2). No-ops on a fresh role, but
-- they make the boundary readable and survive a future accidental grant to
-- the role. pgledger signatures MUST match bootstrap-db-roles.sql /
-- billrun-db-roles.sql exactly or the REVOKE errors on an unknown function
-- (the desired failure mode if signatures drift); FROM PUBLIC as well so this
-- file does not silently depend on rating's having run first.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE
  "billing"."customer_bill",
  "billing"."document",
  "billing"."document_line",
  "billing"."billing_account",
  "billing"."financial_account",
  "billing"."ledger_binding",
  "customer"."party_role",
  "product"."ratecard_version",
  "product"."ratecard_ran_usage_lkp"
FROM reporting_runtime;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION
  "billing"."pgledger_create_account"(text, text, boolean, boolean, jsonb),
  "billing"."pgledger_create_transfer"(text, text, numeric, timestamptz, jsonb),
  "billing"."pgledger_create_transfers"("billing"."transfer_request"[]),
  "billing"."pgledger_create_transfers"("billing"."transfer_request"[], timestamptz, jsonb)
FROM reporting_runtime, PUBLIC;
