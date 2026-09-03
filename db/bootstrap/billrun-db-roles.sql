-- bm14-spec §Implementation §1. Creates the `billrun_runtime` login role — the
-- DB identity the workflow-management component's bill run processor/distributor
-- connect as — and the column-scoped grant surface that makes the phase-2
-- two-writer boundary a DATABASE PRIVILEGE (billmgmt-architecture.md §4, D14/D15).
--
-- NOT a Drizzle migration (D15): creating a role needs CREATEROLE, which
-- app_migrate does not hold. Run once per environment during provisioning,
-- AFTER db:bootstrap-roles AND AFTER db:bootstrap-rating-roles (whose Step 2
-- REVOKE CONNECT … FROM PUBLIC must precede this role's creation, or it inherits
-- CONNECT via PUBLIC — D15). Via `npm run db:bootstrap-billrun-roles`
-- (BOOTSTRAP_DATABASE_URL = a superuser/owner connection) or psql.
-- Contains NO password: see infra/docs/db-role-verification.md for the manual
-- ALTER ROLE … PASSWORD follow-up (never committed).

-- Step 0 — deploy-ordering precondition (D15/T12). Fail closed unless rating's
-- REVOKE CONNECT ON DATABASE ... FROM PUBLIC has already run: if PUBLIC still
-- holds CONNECT on this database, billrun_runtime would inherit it and the
-- isolation intent is silently false from creation. Enforces the run-order
-- (platform -> rating -> billrun) at run time, not just in prose.
DO $$
BEGIN
  IF has_database_privilege('public', current_database(), 'CONNECT') THEN
    RAISE EXCEPTION 'ORDERING: run rating-db-roles.sql (its REVOKE CONNECT ... FROM PUBLIC) before billrun-db-roles.sql (D15/T12)';
  END IF;
END
$$;
--> statement-breakpoint

-- Step 1 — the role (idempotent, convergent ELSE branch strips any drift back to
-- least privilege — a billrun_runtime that drifted to SUPERUSER would bypass
-- every ACL below).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'billrun_runtime') THEN
    CREATE ROLE billrun_runtime WITH LOGIN
      NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS
      CONNECTION LIMIT 20;
  ELSE
    ALTER ROLE billrun_runtime WITH LOGIN
      NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS
      CONNECTION LIMIT 20;
  END IF;
END
$$;
--> statement-breakpoint

-- Step 2 — explicit CONNECT (PUBLIC's default was already revoked by
-- rating-db-roles.sql Step 2; this role must therefore be granted it explicitly,
-- and MUST be created after that revoke — D15).
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO billrun_runtime', current_database());
END
$$;
--> statement-breakpoint

-- Step 3 — schema USAGE (confers no table access on its own).
GRANT USAGE ON SCHEMA "billing" TO billrun_runtime;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "rating"  TO billrun_runtime;
--> statement-breakpoint

-- Step 4 — the id sequences the trial-bill INSERTs default through.
GRANT USAGE ON SEQUENCE "billing"."customer_bill_seq"          TO billrun_runtime;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE "billing"."customer_bill_tax_item_seq" TO billrun_runtime;
--> statement-breakpoint

-- Step 5 — customer_bill: the trial columns only. INSERT and UPDATE are
-- column-scoped to EXCLUDE the three posting stamps (ref_inv_document_id,
-- posted_attempt, charge_checksum) — app-only, set at posting (bm19). SELECT
-- only at the table level; DELETE is deliberately NOT a table grant (T10) — a
-- Postgres DELETE grant cannot be predicate-scoped, so a table-level DELETE
-- would let the worker wipe every unposted trial bill in the schema. The
-- rerun-safe re-derivation deletes through the scoped SECURITY DEFINER function
-- in Step 6b instead; the finalization-latch trigger still protects finalized rows.
GRANT SELECT ON TABLE "billing"."customer_bill" TO billrun_runtime;
--> statement-breakpoint
GRANT INSERT (
  "customer_bill_id","ref_bill_run_id","ref_billing_account_id","period_partition",
  "category","state","billing_period_start","billing_period_end",
  "subtotal","tax_total","total_amount","payment_due_date",
  "ref_bill_format_id","ref_bill_template_version_id"
) ON TABLE "billing"."customer_bill" TO billrun_runtime;
--> statement-breakpoint
GRANT UPDATE (
  "category","state","subtotal","tax_total","total_amount",
  "payment_due_date","ref_bill_format_id","ref_bill_template_version_id"
) ON TABLE "billing"."customer_bill" TO billrun_runtime;
--> statement-breakpoint

-- Step 6 — customer_bill_tax_item: fully worker-owned in phase 2 (Taxation moved
-- to the flow); the app writes none of it.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "billing"."customer_bill_tax_item" TO billrun_runtime;
--> statement-breakpoint

-- Step 6a — app_runtime is NOT a second writer of tax items (T13). Phase 2 moves
-- Taxation into the flow (worker-owned above), so revoke app_runtime's as-built
-- write grant, keeping SELECT — the two-writer boundary is grant-enforced, not
-- "unused by convention".
REVOKE INSERT, UPDATE, DELETE ON TABLE "billing"."customer_bill_tax_item" FROM app_runtime;
--> statement-breakpoint

-- Step 6b — the scoped delete path (T10). A table-level DELETE grant can't be
-- predicate-scoped, so the rerun-safe re-derivation deletes through this
-- SECURITY DEFINER function (owned by the table owner), limited to ONE account's
-- non-finalized bill in ONE run. Finalized rows (ref_inv_document_id set) are
-- never touched; ON DELETE CASCADE removes the bill's tax items.
CREATE OR REPLACE FUNCTION "billing".billrun_delete_trial_bill(p_run text, p_ban text)
RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = billing AS $$
  WITH d AS (
    DELETE FROM billing.customer_bill
     WHERE ref_bill_run_id = p_run
       AND ref_billing_account_id = p_ban
       AND ref_inv_document_id IS NULL
    RETURNING 1
  )
  SELECT count(*)::integer FROM d;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "billing".billrun_delete_trial_bill(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT  EXECUTE ON FUNCTION "billing".billrun_delete_trial_bill(text, text) TO billrun_runtime;
--> statement-breakpoint

-- Step 7 — the udr_rated claim (RATED → BILL_DRAFT). SELECT to read the charges
-- it aggregates; UPDATE on EXACTLY the six claim columns — the same set
-- app_runtime already holds (rating rm03 Step 5). No INSERT (rating owns inserts);
-- no other column.
GRANT SELECT ON TABLE "rating"."udr_rated" TO billrun_runtime;
--> statement-breakpoint
GRANT UPDATE (
  "status","billrun_ref_id","billrun_ban_id",
  "billrun_attempt","billrun_checksum","upsert_datetime"
) ON TABLE "rating"."udr_rated" TO billrun_runtime;
--> statement-breakpoint

-- Step 7b — role-aware transition guard (T4/D14). A column grant can't bind a
-- value to a role, so the six-column UPDATE alone would let billrun_runtime write
-- status='BILL_APPROVED'/'REJECTED'. This trigger constrains ONLY billrun_runtime
-- (via session_user) to the RATED -> BILL_DRAFT claim; app_runtime's approve/
-- reject/release transitions are untouched. Created here in the billing bootstrap
-- so it ships with the role (no edit to rating's scripts — D15).
CREATE OR REPLACE FUNCTION "rating".billrun_status_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF session_user = 'billrun_runtime'
     AND NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'RATED' AND NEW.status = 'BILL_DRAFT') THEN
    RAISE EXCEPTION 'billrun_runtime may only transition udr_rated RATED -> BILL_DRAFT (got % -> %)', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS billrun_status_guard_trg ON "rating"."udr_rated";
--> statement-breakpoint
CREATE TRIGGER billrun_status_guard_trg
  BEFORE UPDATE OF status ON "rating"."udr_rated"
  FOR EACH ROW EXECUTE FUNCTION "rating".billrun_status_guard();
--> statement-breakpoint

-- Step 8 — read-only context the flow resolves the bill from. Enumerated per
-- table, never ON ALL TABLES.
GRANT SELECT ON TABLE
  "billing"."bill_run",
  "billing"."bill_run_account",
  "billing"."billing_account",
  "billing"."bill_cycle"
TO billrun_runtime;
--> statement-breakpoint

-- Step 9 — the run-state write REVOKE (billmgmt-architecture.md Inv #2). Strictly
-- redundant (never granted) and kept as a declaration of intent a reviewer reads
-- and a test asserts: the worker never writes run-state, the ingest handler does.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE
  "billing"."bill_run",
  "billing"."bill_run_account",
  "billing"."bill_run_account_stage",
  "billing"."document"
FROM billrun_runtime;
--> statement-breakpoint

-- Step 10 — the pgledger SECURITY DEFINER REVOKE (Inv #1, mirroring rating
-- rm03 Step 9). PUBLIC's EXECUTE was already stripped by rating; repeated FROM
-- billrun_runtime as intent so the worker can never post a ledger transfer
-- regardless of table grants. Signatures MUST match bootstrap-db-roles.sql /
-- rating-db-roles.sql exactly or the REVOKE errors on an unknown function
-- (the desired failure mode if signatures drift).
REVOKE EXECUTE ON FUNCTION
  "billing"."pgledger_create_account"(text, text, boolean, boolean, jsonb),
  "billing"."pgledger_create_transfer"(text, text, numeric, timestamptz, jsonb),
  "billing"."pgledger_create_transfers"("billing"."transfer_request"[]),
  "billing"."pgledger_create_transfers"("billing"."transfer_request"[], timestamptz, jsonb)
FROM billrun_runtime;
--> statement-breakpoint

-- Step 11 — what this file deliberately does NOT do: it grants billrun_runtime
-- NOTHING on the `kestra` database. rm03a's REVOKE CONNECT ON DATABASE kestra
-- FROM PUBLIC already refuses it; a role with no explicit kestra CONNECT is
-- rejected. No ALTER DEFAULT PRIVILEGES for billrun_runtime either — a future
-- billing table it must write gets an explicit per-table grant in this file.
