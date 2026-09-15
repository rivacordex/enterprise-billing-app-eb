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

-- Step 1 — the role (idempotent, convergent ELSE branch strips attribute
-- drift back to least privilege — a billrun_runtime that drifted to
-- SUPERUSER would bypass every ACL below — and fails closed on membership/
-- ownership drift, which ALTER ROLE cannot fix).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'billrun_runtime') THEN
    CREATE ROLE billrun_runtime WITH LOGIN
      NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS
      CONNECTION LIMIT 20;
  ELSE
    -- Fail closed on drift ALTER ROLE cannot fix: membership in another role
    -- or ownership of an object would both survive the attribute reset below
    -- and could bypass every ACL this file grants. Reject rather than
    -- silently re-provisioning over it.
    IF EXISTS (
      SELECT FROM pg_catalog.pg_auth_members m
      JOIN pg_catalog.pg_roles r ON r.oid = m.member
      WHERE r.rolname = 'billrun_runtime'
    ) THEN
      RAISE EXCEPTION 'DRIFT: billrun_runtime is a member of another role — reconcile membership drift before provisioning (D14/D15)';
    END IF;
    IF EXISTS (
      SELECT FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
      WHERE r.rolname = 'billrun_runtime'
    ) THEN
      RAISE EXCEPTION 'DRIFT: billrun_runtime owns one or more objects — reconcile ownership drift before provisioning (D14/D15)';
    END IF;

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

-- Step 3 — schema USAGE (confers no table access on its own). `inventory` is
-- added by bm27 (§Implementation §5): Collection resolves a RAN_USAGE row's
-- subscriber ref to a billing account through `inventory.product_inventory`
-- (Inv #24), so the read-context set (Step 8) now spans it — USAGE only, never
-- a write privilege of any kind on `inventory` (bm27 guardrail; Inv #25/D32).
-- `product` is added by bm28 (§Implementation §3): Aggregation reads the
-- offering NAME for a USAGE line's human-readable `description` from
-- `product.product_offering` (the grain id itself is denormalized on
-- `product_inventory` and needs no product read). USAGE only — no write of any
-- kind on `product` anywhere in this file (bm28 guardrail).
GRANT USAGE ON SCHEMA "billing"   TO billrun_runtime;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "rating"    TO billrun_runtime;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "inventory" TO billrun_runtime;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "product"   TO billrun_runtime;
--> statement-breakpoint

-- Step 4 — the id sequences the trial-bill INSERTs default through.
GRANT USAGE ON SEQUENCE "billing"."customer_bill_seq"          TO billrun_runtime;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE "billing"."customer_bill_tax_item_seq" TO billrun_runtime;
--> statement-breakpoint
-- bm23-spec §Implementation §4. The BLN id sequence customer_bill_line INSERTs
-- default through (its charge lines are worker-inserted, Step 5a below).
GRANT USAGE ON SEQUENCE "billing"."customer_bill_line_seq"     TO billrun_runtime;
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

-- Step 5a — customer_bill_line (bm23-spec §Implementation §4). The charge
-- record's two-writer boundary, again (Inv #3): billrun_runtime INSERTs and
-- reads; app_runtime reads only. billrun_runtime gets SELECT + a column-scoped
-- INSERT covering every column, but NO table DELETE and NO UPDATE:
--   * No DELETE — re-derivation is the whole-account replace (Inv #16, D22),
--     which deletes the trial `customer_bill` header through the scoped
--     SECURITY DEFINER `billrun_delete_trial_bill` (Step 6b); the ON DELETE
--     CASCADE FK (0039) removes the lines under the function OWNER's rights, not
--     the caller's — so a caller DELETE grant is neither needed nor wanted (it
--     could not be predicate-scoped, T10 precedent).
--   * No UPDATE — a line is never patched in place; re-derivation is
--     delete-then-insert, never a per-line upsert (Inv #16).
GRANT SELECT ON TABLE "billing"."customer_bill_line" TO billrun_runtime;
--> statement-breakpoint
GRANT INSERT (
  "customer_bill_line_id","ref_customer_bill_id","period_partition","line_no",
  "source","line_type","ref_product_offering_id","udr_type","description",
  "quantity","unit","gross_amount","discount_amount","net_amount",
  "discount_type","discount_rate","discount_amount_raw","udr_count",
  "grouping_key","currency","snapshot_price_ref","snapshot_unit_price",
  "snapshot_quantity","snapshot_effective_date"
) ON TABLE "billing"."customer_bill_line" TO billrun_runtime;
--> statement-breakpoint

-- Step 5b — app_runtime reads customer_bill_line but never writes it (Inv #3).
-- bootstrap-db-roles.sql's `ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate IN
-- SCHEMA "billing" GRANT SELECT, INSERT, UPDATE, DELETE ... TO app_runtime`
-- auto-grants app_runtime FULL DML on every NEW billing table, so this one must
-- be EXPLICITLY revoked back to SELECT-only — the boundary is grant-enforced,
-- not "unused by convention" (bm14 Step 6a precedent for customer_bill_tax_item).
-- GRANT SELECT first (idempotent, and closes the "scratch setup billing grant
-- gap" where the default-priv may not have fired on a from-scratch DB), then
-- REVOKE only the writes.
GRANT SELECT ON TABLE "billing"."customer_bill_line" TO app_runtime;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON TABLE "billing"."customer_bill_line" FROM app_runtime;
--> statement-breakpoint

-- Step 6 — customer_bill_tax_item: fully worker-owned in phase 2 (Taxation moved
-- to the flow); the app writes none of it.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "billing"."customer_bill_tax_item" TO billrun_runtime;
--> statement-breakpoint

-- Step 6a — app_runtime is NOT a second writer of tax items (T13). Phase 2 moves
-- Taxation into the flow (worker-owned above), so revoke app_runtime's as-built
-- write grant, keeping SELECT — the two-writer boundary is grant-enforced, not
-- "unused by convention".
--
-- The SELECT is GRANTed EXPLICITLY here rather than assumed: bootstrap-db-roles.sql
-- enumerates app_runtime's `billing` grants to the ac01-era tables only and sets
-- NO `ALTER DEFAULT PRIVILEGES` for the schema, so a bill-run table created by a
-- later migration receives no app_runtime grant on a from-scratch DB (the
-- "scratch setup billing grant gap"). Granting SELECT first makes "keeping SELECT"
-- true regardless of how migrations were applied; the REVOKE then removes only the
-- writes. (The other bill-run tables app_runtime reads/writes — customer_bill,
-- bill_run*, bill_run_invoices, bill_run_distribution — have the same underlying
-- gap; closing it schema-wide is tracked separately, see billmgmt-known-issues.)
GRANT SELECT ON TABLE "billing"."customer_bill_tax_item" TO app_runtime;
--> statement-breakpoint
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

-- Step 7b — role-aware transition guard (T4/D14; narrowed by bm25). A column
-- grant can't bind a value to a role, so the six-column UPDATE alone would let
-- billrun_runtime write status='BILL_APPROVED'/'REJECTED', or rewrite the other
-- five claim columns on a row it no longer owns (e.g. an already-BILL_DRAFT/
-- APPROVED row) since a column grant doesn't scope by state. This trigger
-- constrains ONLY billrun_runtime (via session_user), via two independent
-- checks: (1) status may only move RATED -> BILL_DRAFT — the processor is the
-- SOLE re-claimer, and after bm24 the claimable source set is EXACTLY pristine
-- RATED rows: reject/cancel/rerun now RELEASE claimed rows back to RATED (four
-- claim columns NULLed) rather than parking them at REJECTED, so no billing path
-- produces a REJECTED udr_rated row any longer. bm25 therefore retires the
-- vestigial (RATED | REJECTED) allowance and narrows to RATED only (bm25-spec
-- §Implementation §3); (2) the other five claim columns may only change while
-- the row is still claimable (RATED) — the worker claims a row across several
-- statements before flipping status last, so the claim columns and the status
-- flip are NOT required to change together in one statement; only the row's
-- CURRENT status at the time of each write is constrained, which still forbids
-- rewriting the claim of an already-committed BILL_DRAFT/BILL_APPROVED row.
-- app_runtime's approve/reject/release transitions (incl. the bm24
-- BILL_DRAFT -> RATED release) are untouched. Fires on all six columns (not just
-- status) so a claim-only write with status omitted from the SET list still
-- invokes validation. Created here in the billing bootstrap so it ships with the
-- role (no edit to rating's scripts — D15).
CREATE OR REPLACE FUNCTION "rating".billrun_status_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF session_user = 'billrun_runtime' THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT (OLD.status = 'RATED' AND NEW.status = 'BILL_DRAFT') THEN
      RAISE EXCEPTION 'billrun_runtime may only claim udr_rated to BILL_DRAFT from RATED (got % -> %)', OLD.status, NEW.status;
    END IF;

    IF (
         NEW.billrun_ref_id   IS DISTINCT FROM OLD.billrun_ref_id OR
         NEW.billrun_ban_id   IS DISTINCT FROM OLD.billrun_ban_id OR
         NEW.billrun_attempt  IS DISTINCT FROM OLD.billrun_attempt OR
         NEW.billrun_checksum IS DISTINCT FROM OLD.billrun_checksum OR
         NEW.upsert_datetime  IS DISTINCT FROM OLD.upsert_datetime
       )
       AND OLD.status <> 'RATED' THEN
      RAISE EXCEPTION 'billrun_runtime may only change udr_rated claim columns while the row is claimable (RATED) (was %)', OLD.status;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS billrun_status_guard_trg ON "rating"."udr_rated";
--> statement-breakpoint
CREATE TRIGGER billrun_status_guard_trg
  BEFORE UPDATE OF
    status, billrun_ref_id, billrun_ban_id,
    billrun_attempt, billrun_checksum, upsert_datetime
  ON "rating"."udr_rated"
  FOR EACH ROW EXECUTE FUNCTION "rating".billrun_status_guard();
--> statement-breakpoint

-- Step 8 — read-only context the flow resolves the bill from. Enumerated per
-- table, never ON ALL TABLES. bm27 adds `inventory.product_inventory` (§5): the
-- subscriber→account correlation reads inventory's truth (product_inventory_id
-- → billing_account_id) but NEVER mutates it — SELECT only, and no INSERT/
-- UPDATE/DELETE grant on `inventory` exists anywhere in this file (Step 3 grants
-- schema USAGE only; a guardrail asserts nothing on the billing/flow side writes
-- product_inventory.billing_account_id — Inv #25/D32). bm28 adds
-- `product.product_offering` (§3): Aggregation reads the offering NAME for a
-- USAGE line's `description` — SELECT only, no write on `product` anywhere here.
GRANT SELECT ON TABLE
  "billing"."bill_run",
  "billing"."bill_run_account",
  "billing"."billing_account",
  "billing"."bill_cycle",
  "inventory"."product_inventory",
  "product"."product_offering"
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
-- PUBLIC here too (harmless no-op if already revoked) so this file's own
-- REVOKE doesn't silently depend on rating's having run first, and FROM
-- billrun_runtime as intent — the worker can never post a ledger transfer
-- regardless of table grants. Signatures MUST match bootstrap-db-roles.sql /
-- rating-db-roles.sql exactly or the REVOKE errors on an unknown function
-- (the desired failure mode if signatures drift).
REVOKE EXECUTE ON FUNCTION
  "billing"."pgledger_create_account"(text, text, boolean, boolean, jsonb),
  "billing"."pgledger_create_transfer"(text, text, numeric, timestamptz, jsonb),
  "billing"."pgledger_create_transfers"("billing"."transfer_request"[]),
  "billing"."pgledger_create_transfers"("billing"."transfer_request"[], timestamptz, jsonb)
FROM billrun_runtime, PUBLIC;
--> statement-breakpoint

-- Step 11 — what this file deliberately does NOT do: it grants billrun_runtime
-- NOTHING on the `kestra` database. rm03a's REVOKE CONNECT ON DATABASE kestra
-- FROM PUBLIC already refuses it; a role with no explicit kestra CONNECT is
-- rejected. No ALTER DEFAULT PRIVILEGES for billrun_runtime either — a future
-- billing table it must write gets an explicit per-table grant in this file.
