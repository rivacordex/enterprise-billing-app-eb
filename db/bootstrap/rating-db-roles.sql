-- rm03-spec §Implementation §1. Creates the `rating_runtime` login role and
-- the complete grant surface that makes the rating/billing separation a
-- DATABASE PRIVILEGE rather than a code convention (Inv #1, #2, #17a, #18).
--
-- NOT a Drizzle migration (rm03-spec D11): creating a role needs CREATEROLE,
-- which `app_migrate` — the role the automated `migrate` stage runs as — does
-- not hold, so this cannot sit in the sequence `db/migrate.ts` iterates. It
-- also references `rating`/`product`/`ordering`/`inventory`/`billing` tables
-- and the `app_runtime`/`app_migrate` roles that must already exist. Run it
-- once per environment during provisioning, AFTER the initial superuser/owner
-- `db:migrate` and AFTER `db:bootstrap-roles`, via
-- `npm run db:bootstrap-rating-roles` (a superuser/owner connection string in
-- `BOOTSTRAP_DATABASE_URL`) or directly with `psql`. See the provisioning
-- order in infra/docs/db-role-verification.md.
--
-- A NEW FILE, not an edit to bootstrap-db-roles.sql (rm03-spec D11): that file
-- is a platform artefact covering six schemas; rating adds a seventh plus two
-- revokes that reach into `billing`. Keeping it separate makes the rating
-- boundary — and D7's revoke — reviewable as one diff.
--
-- Idempotent via `DO` blocks. Deliberately contains NO password: see
-- infra/docs/db-role-verification.md for the manual `ALTER ROLE ... PASSWORD`
-- follow-up (never committed). The statement-breakpoint marker lines below let
-- db/bootstrap/rating-db-roles.ts split the file into individual statements;
-- they are SQL line comments, so running the whole file through `psql` works too.

-- Step 1 — the role (idempotent). The ELSE branch matters: re-running must
-- CONVERGE the role, not skip it (rm03-spec D10). It converges both the
-- connection limit AND the attribute set: LOGIN plus an explicit
-- NOSUPERUSER/NOCREATEROLE/NOCREATEDB/NOREPLICATION/NOBYPASSRLS. These are the
-- CREATE-time defaults (redundant on the IF branch, kept as a reviewer-visible
-- declaration of intent, like Step 8's revoke) but LOAD-BEARING on the ELSE
-- branch: a pre-existing rating_runtime that drifted to SUPERUSER would bypass
-- every ACL this unit builds (D6: superusers and the owner bypass the ACL
-- entirely), forging straight through Inv #1/#2. Re-running strips it back to
-- least privilege.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'rating_runtime') THEN
    CREATE ROLE rating_runtime WITH LOGIN
      NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS
      CONNECTION LIMIT 20;
  ELSE
    ALTER ROLE rating_runtime WITH LOGIN
      NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS
      CONNECTION LIMIT 20;
  END IF;
END
$$;
--> statement-breakpoint

-- Step 2 — close the PUBLIC CONNECT default (rm03-spec D6), then grant
-- explicitly. A NULL datacl means the built-in default is in force, and that
-- default includes CONNECT for PUBLIC — so Inv #18 (rm04's engine role holds
-- no CONNECT) is unenforceable until PUBLIC loses it. `app_runtime` and
-- `app_migrate` already hold explicit CONNECT (bootstrap-db-roles.sql lines
-- 42, 61) and are unaffected. CONFIRM before running that no other role
-- reaches this database only through PUBLIC.
DO $$
BEGIN
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO rating_runtime', current_database());
END
$$;
--> statement-breakpoint

-- Step 3 — schema USAGE. USAGE alone confers no table access (rm03-spec D9).
GRANT USAGE ON SCHEMA "rating"    TO rating_runtime;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "product"   TO rating_runtime;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "ordering"  TO rating_runtime;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "inventory" TO rating_runtime;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "billing"   TO rating_runtime;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "core"      TO rating_runtime;   -- D8
--> statement-breakpoint
GRANT USAGE ON SCHEMA "rating"    TO app_runtime;
--> statement-breakpoint

-- Step 4 — `rating` tables, parent only (rm03-spec D3), column-scoped (D1).
-- Grants go on the partitioned parent; partitions receive none, so a partition
-- pg_partman creates later is usable through the parent with no re-grant, and
-- addressing a partition directly is refused (Inv #17a).

-- udr_rated: insert and read freely; update `status` and nothing else.
GRANT SELECT, INSERT ON TABLE "rating"."udr_rated" TO rating_runtime;
--> statement-breakpoint
GRANT UPDATE ("status") ON TABLE "rating"."udr_rated" TO rating_runtime;
--> statement-breakpoint

-- udr_batch: the claim row is inserted then progressed through its lifecycle.
-- NOT granted UPDATE on batch_id, file_key, source_file, file_key_rule,
-- udr_type, batch_run_num or received_at — the identity and claim columns, so
-- a batch cannot be re-pointed at a different file_key after the fact (Inv #7).
GRANT SELECT, INSERT ON TABLE "rating"."udr_batch" TO rating_runtime;
--> statement-breakpoint
GRANT UPDATE (
  "status","started_at","completed_at",
  "file_checksum","file_size_bytes","declared_record_count",
  "parsed_count","rated_count","rejected_count","discarded_count","superseded_count",
  "reject_file_path","archive_file_path",
  "workflow_execution_id","workflow_flow_revision","rating_engine_version",
  "superseded_by_batch_id","supersede_reason","error_summary"
) ON TABLE "rating"."udr_batch" TO rating_runtime;
--> statement-breakpoint

-- process_log: append-only, by construction.
GRANT SELECT, INSERT ON TABLE "rating"."process_log" TO rating_runtime;
--> statement-breakpoint

-- event_catalog: read-only at runtime; seeded by rm02 under app_migrate.
GRANT SELECT ON TABLE "rating"."event_catalog" TO rating_runtime;
--> statement-breakpoint

-- Step 5 — the billing boundary, in the app's direction (rm03-spec D1).
-- Exactly six updatable columns on udr_rated — not seven; the verification
-- asserts the count. udr_ref_batch_id is deliberately NOT updatable: it is the
-- single lineage anchor, set once at insert. `status` is the only column both
-- roles may update.
GRANT SELECT ON TABLE "rating"."udr_rated" TO app_runtime;
--> statement-breakpoint
GRANT UPDATE (
  "status", "billrun_ref_id", "billrun_ban_id",
  "billrun_attempt", "billrun_checksum", "upsert_datetime"
) ON TABLE "rating"."udr_rated" TO app_runtime;
--> statement-breakpoint
GRANT SELECT ON TABLE
  "rating"."udr_batch", "rating"."process_log", "rating"."event_catalog"
TO app_runtime;
--> statement-breakpoint

-- Step 6 — sequences and functions the inserts actually need (rm03-spec D8).
-- A DEFAULT or CHECK that calls a function requires EXECUTE/USAGE by the
-- INSERTING role: udr_batch.batch_id defaults through udr_batch_seq, udr_rated
-- has a period_of() CHECK, udr_id/log_id default to core.generate_ulid().
-- Granted EXPLICITLY so the module survives a future
-- `REVOKE EXECUTE ... FROM PUBLIC` hardening pass rather than riding on the
-- PUBLIC default D7 identifies as a hole.
GRANT USAGE ON SEQUENCE "rating"."udr_batch_seq" TO rating_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "rating"."period_of"(timestamptz) TO rating_runtime, app_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."generate_ulid"() TO rating_runtime;
--> statement-breakpoint

-- Step 7 — cross-schema reads, enumerated per table, never ON ALL TABLES
-- (rm03-spec D9). A genuinely new read requirement is a reviewed one-line change.
GRANT SELECT ON TABLE
  "product"."product_offering",
  "product"."product_offering_price",
  "ordering"."product_order_item",
  "ordering"."order_item_price_override",
  "inventory"."product_inventory",
  "billing"."billing_account",
  "billing"."bill_cycle"
TO rating_runtime;
--> statement-breakpoint

-- Step 8 — the explicit `billing` write revoke (Inv #1). Strictly redundant —
-- the role was never granted them — and kept anyway as a declaration of intent
-- a reviewer reads and a test asserts. If someone later widens `billing`'s
-- default privileges, this line is where the conflict shows up.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA "billing" FROM rating_runtime;
--> statement-breakpoint

-- Step 9 — close the SECURITY DEFINER EXECUTE hole (rm03-spec D7, escalation
-- E1). PUBLIC holds EXECUTE by default on these four billing SECURITY DEFINER
-- functions, so ANY login role can post ledger transfers — which would make
-- Inv #1 false no matter how the table grants are written, and revoking from
-- rating_runtime alone is a no-op while PUBLIC still holds it. Scoped to the
-- four deliberately: a blanket ON ALL FUNCTIONS ... FROM PUBLIC would also
-- strip the SECURITY INVOKER helpers, which are already gated by their own
-- table grants. Signatures copied from bootstrap-db-roles.sql lines 191–196 —
-- they must match exactly or the REVOKE errors on an unknown function, which
-- is the desired failure mode if the signatures ever drift.
REVOKE EXECUTE ON FUNCTION
  "billing"."pgledger_create_account"(text, text, boolean, boolean, jsonb),
  "billing"."pgledger_create_transfer"(text, text, numeric, timestamptz, jsonb),
  "billing"."pgledger_create_transfers"("billing"."transfer_request"[]),
  "billing"."pgledger_create_transfers"("billing"."transfer_request"[], timestamptz, jsonb)
FROM PUBLIC;
--> statement-breakpoint

-- Step 9a — what this script deliberately does NOT do (rm03-spec §Implementation
-- Step 9a): it does not create the `kestra` database or the `kestra_engine`
-- role. Those are rm03a, a separate unit in this same repository and boundary,
-- for one reason that matters: `kestra_engine` must be created AFTER the
-- `REVOKE CONNECT ... FROM PUBLIC` in Step 2, or it inherits access to the
-- billing database through PUBLIC and Inv #18 is false from the moment it
-- exists. rm03a also applies the mirror-image revoke on the `kestra` database.

-- Step 10 — default privileges for future `rating` tables (rm03-spec D5).
-- SELECT only: `ALTER DEFAULT PRIVILEGES` CANNOT be column-scoped, so any
-- default carrying UPDATE would be table-wide — silently granting a future
-- rating table's money columns to app_runtime the moment it is created. A
-- future rating table needing INSERT or a column-scoped UPDATE gets an
-- EXPLICIT per-table grant in the migration that creates it.
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate IN SCHEMA "rating"
  GRANT SELECT ON TABLES TO rating_runtime;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate IN SCHEMA "rating"
  GRANT SELECT ON TABLES TO app_runtime;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate IN SCHEMA "rating"
  GRANT USAGE, SELECT ON SEQUENCES TO rating_runtime;
--> statement-breakpoint

-- Step 11 — app_migrate owns the schema.
GRANT ALL ON SCHEMA "rating" TO app_migrate;
--> statement-breakpoint
GRANT ALL ON ALL TABLES IN SCHEMA "rating" TO app_migrate;
--> statement-breakpoint
GRANT ALL ON ALL SEQUENCES IN SCHEMA "rating" TO app_migrate;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate IN SCHEMA "rating" GRANT ALL ON TABLES TO app_migrate;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate IN SCHEMA "rating" GRANT ALL ON SEQUENCES TO app_migrate;
