# bm14 — `billrun_runtime` Role & the Two-Writer Grant Boundary

**Unit:** bm14 (Phase 2 · Phase F). **Boundary:** `db/bootstrap/**` (billing-owned, standalone SQL — **not** a Drizzle migration). **Specs from:** `billmgmt-architecture.md` §4 (two-writer boundary, deviation #1/#2), `_updatemodule-billing-billrun-phase2-plan.md` §15 **D14/D15**, `bm00-build-plan.md` Unit 14. **Model file:** `db/bootstrap/rating-db-roles.sql` (mirror it).

> **Workflow-management framing.** Kestra is the **workflow management component** — a sister component that supports the billing app through three functions: **rating engine**, **bill run processor**, and **bill run distributor**. The rating engine connects to the database as `rating_runtime`; the bill-run functions (processor + distributor) connect as the **`billrun_runtime`** role this unit creates. This unit makes the phase-2 "two writers on `billing`" boundary a **database privilege**, not a code convention.

## Goal

Create the least-privilege **`billrun_runtime`** Postgres login the workflow-management component's bill-run functions connect as, and grant it exactly enough to write the bill-data it owns — `customer_bill` (trial columns only), `customer_bill_tax_item`, and the six `udr_rated` claim columns — while a database privilege refuses it everything else (run-state tables, `billing.document`, the pgledger `SECURITY DEFINER` functions, and the `kestra` database).

## Design

**Structural decisions**

- **Exact analogue of `rating_runtime`.** This is `rating-db-roles.sql` for the billing side: a standalone, idempotent bootstrap SQL run once per environment by a superuser/owner connection, split into statements by `--> statement-breakpoint` markers and driven by a small `.ts` runner. It is **not** a Drizzle migration because creating a role needs `CREATEROLE`, which `app_migrate` (the automated `migrate` role) does not hold.
- **Ordering is load-bearing (D15).** `billrun_runtime` must be created **after** `rating-db-roles.sql` has run its `REVOKE CONNECT ON DATABASE … FROM PUBLIC`. Created before that revoke, the role would inherit `CONNECT` via `PUBLIC` and the isolation intent is silently false from the moment it exists. Provisioning order: `db:bootstrap-roles` → `db:bootstrap-rating-roles` → **`db:bootstrap-billrun-roles`**.
- **No password in the file.** Same as rating: a manual `ALTER ROLE billrun_runtime PASSWORD …` follow-up, sourced from Key Vault, never committed. Recorded in `infra/docs/db-role-verification.md`.
- **The two-writer split, as columns.** Both `app_runtime` and `billrun_runtime` can write `customer_bill`, but on **different columns** — the boundary is which columns each may touch:

  | Object / columns                                                                                                                                                                             | `billrun_runtime` (bill run processor)                                                                                      | `app_runtime` (control plane + posting)                                            |
  | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
  | `customer_bill` — trial columns (`category`, `state`, `billing_period_*`, `subtotal`, `tax_total`, `total_amount`, `payment_due_date`, `ref_bill_format_id`, `ref_bill_template_version_id`) | **INSERT / UPDATE** (column-scoped); **DELETE only via the scoped `SECURITY DEFINER` fn** `billrun_delete_trial_bill` (T10) | (retains its as-built grant)                                                       |
  | `customer_bill` — **posting stamps** (`ref_inv_document_id`, `posted_attempt`, `charge_checksum`)                                                                                            | **— none** (excluded from its INSERT/UPDATE)                                                                                | UPDATE (posting, bm11/bm19)                                                        |
  | `customer_bill_tax_item`                                                                                                                                                                     | **SELECT / INSERT / UPDATE / DELETE** (worker-owned)                                                                        | **SELECT only** — writes REVOKEd (T13)                                             |
  | `rating.udr_rated` — the six claim columns (`status`, `billrun_ref_id`, `billrun_ban_id`, `billrun_attempt`, `billrun_checksum`, `upsert_datetime`)                                          | **SELECT + UPDATE(6)** — the `RATED → BILL_DRAFT` claim                                                                     | SELECT + UPDATE(6) (approve/reject/release, bm17) — already granted by rating rm03 |
  | `bill_run` / `bill_run_account` / `bill_run_account_stage`                                                                                                                                   | **SELECT only** (read run context); **explicit REVOKE** on writes                                                           | full (app owns run-state)                                                          |
  | `billing.document` + pgledger `SECURITY DEFINER` fns                                                                                                                                         | **explicit REVOKE** (incl. from `PUBLIC` — already done by rating; repeated as intent)                                      | (posting path)                                                                     |
  | `kestra` database                                                                                                                                                                            | **no grant of any kind** (refused via rm03a's `PUBLIC` revoke)                                                              | n/a                                                                                |

- **Column-scoped INSERT (not just UPDATE) on `customer_bill`.** The three posting-stamp columns are excluded from `billrun_runtime`'s `INSERT` grant, not only its `UPDATE`. The finalization-latch trigger (bm13/`0033`) blocks _UPDATE/DELETE_ of a finalized row but does **not** block an _INSERT_ that pre-sets `ref_inv_document_id`; excluding those columns from INSERT closes that hole structurally, so a worker can never mint a "pre-finalized" bill with no real INV.
- **DELETE on `customer_bill` is a scoped `SECURITY DEFINER` function, not a table grant (T10).** Under B-fat the Aggregation stage performs the rerun-safe re-derivation (delete-then-insert `WHERE ref_inv_document_id IS NULL`), the write path that moved from the app (bm05/bm08) to the worker. Because a Postgres `DELETE` grant cannot be predicate-scoped, a table-level `DELETE` would let the worker wipe every unposted trial bill in the schema; instead the worker calls `billing.billrun_delete_trial_bill(run, ban)` (Step 6b), which deletes only that account's non-finalized bill in that run. The `ON DELETE CASCADE` FK removes the bill's tax items automatically.

## Implementation

### 1. `db/bootstrap/billrun-db-roles.sql` (new)

Idempotent, statement-breakpoint-delimited, modeled line-for-line on `rating-db-roles.sql`. Full content:

```sql
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
```

### 2. `db/bootstrap/billrun-db-roles.ts` (new)

Copy `rating-db-roles.ts` verbatim, changing only the file it reads and the log labels: read `billrun-db-roles.sql`, split on `--> statement-breakpoint`, execute each statement over the `BOOTSTRAP_DATABASE_URL` (superuser/owner) connection, log per step, exit non-zero on failure. Same `postgres()` single-connection + explicit `process.exit()` idiom as the sibling bootstrap runners.

### 3. `package.json` script

Add, alongside `db:bootstrap-rating-roles`:

```json
"db:bootstrap-billrun-roles": "node --env-file=.env --import tsx db/bootstrap/billrun-db-roles.ts"
```

### 4. Password provisioning & docs

- Extend `infra/docs/db-role-verification.md` with the `billrun_runtime` `ALTER ROLE … PASSWORD` step (from Key Vault), the **provisioning order** (`roles → rating-roles → billrun-roles`), and the connection-string env var the app/engine uses for this role (`BILLRUN_RUNTIME_DATABASE_URL`, added to `.env.example` with a dummy value; the real value in Key Vault).
- The role's password is a **third credential** (after the app bearer token and the outbound engine Basic-Auth) — record it in the phase-2 credentials list (`billmgmt-architecture.md` §4 / plan §9).

### 5. Guardrail test — `tests/db/billrun-db-roles.integration.test.ts` (new)

DB-gated (skips loudly under `DATABASE_URL` unset), connecting **as `billrun_runtime`** (its own connection string), asserting the boundary per column/table — the phase-2 analogue of the rating role test:

- **Can:** `INSERT`/`UPDATE`(scoped)/`SELECT` a trial `customer_bill`, and delete it **only via `billing.billrun_delete_trial_bill(run, ban)`** (removes just that account's non-finalized bill in that run); `INSERT`/`UPDATE`/`DELETE`/`SELECT` a `customer_bill_tax_item`; `UPDATE` the six `udr_rated` claim columns for a `RATED → BILL_DRAFT` claim; `SELECT` `bill_run`/`bill_run_account`/`billing_account`/`bill_cycle`.
- **Refused (per column):** `UPDATE`/`INSERT` of `customer_bill.ref_inv_document_id`, `.posted_attempt`, `.charge_checksum`; `UPDATE` of any `udr_rated` column outside the six (enumerated over `pg_attribute` so a widened grant _or a newly added column_ fails the build).
- **Refused (value — trigger, Step 7b):** `billrun_runtime` updating `udr_rated.status` to anything other than `BILL_DRAFT` from `RATED` (e.g. `→ BILL_APPROVED`/`REJECTED`) raises; `RATED → BILL_DRAFT` succeeds.
- **Refused (per table):** any **direct** `DELETE` on `customer_bill` (table grant removed, Step 5); any `INSERT`/`UPDATE`/`DELETE` on `bill_run`, `bill_run_account`, `bill_run_account_stage`, `billing.document`; any `INSERT` into `rating.udr_rated`; and `app_runtime` writing `customer_bill_tax_item` (revoked, Step 6a).
- **Refused (functions):** calling `billing.pgledger_create_transfer(...)` → permission denied.
- **Refused (database):** a `billrun_runtime` connection to the `kestra` database is `FATAL: permission denied for database`; and it holds `CONNECT` on the billing DB only via its explicit grant (not `PUBLIC`).

## Dependencies

- **No new npm packages.** Reuses `postgres`/`tsx` and the existing bootstrap-runner pattern.
- **Env:** `BOOTSTRAP_DATABASE_URL` (exists, superuser/owner) to run the bootstrap; `BILLRUN_RUNTIME_DATABASE_URL` (new — the `billrun_runtime` connection string, dummy in `.env.example`, real in Key Vault).
- **External prerequisites (must already exist):**
  - The **rating** module's `rating.udr_rated` table (rm01) and `rating-db-roles.sql` **already run** in the target environment — its `REVOKE CONNECT … FROM PUBLIC` must precede this unit (D15).
  - Phase-1 `billing.customer_bill` / `customer_bill_tax_item` / `bill_run*` and the pgledger `SECURITY DEFINER` functions (bm05/bm06/bm09) — already delivered.
  - `app_runtime` / `app_migrate` (platform bootstrap).

## Verification checklist

- [ ] `db/bootstrap/billrun-db-roles.sql` and `billrun-db-roles.ts` exist; `npm run db:bootstrap-billrun-roles` runs idempotently (a second run converges, no error).
- [ ] Running it **before** `rating-db-roles.sql` fails loudly — the Step 0 ordering guard raises `ORDERING:` while `PUBLIC` still holds `CONNECT`, proving the run-order is enforced at run time, not just documented.
- [ ] `billrun_runtime` exists with `LOGIN`, `NOSUPERUSER`/`NOCREATEROLE`/`NOCREATEDB`/`NOREPLICATION`/`NOBYPASSRLS`, connection limit 20, and no password committed.
- [ ] The guardrail test (§5) passes: every **can** succeeds, every **refused** raises a permission error, asserted per column/table over `pg_attribute`.
- [ ] `billrun_runtime` is refused `CONNECT` to the `kestra` database, and holds billing `CONNECT` only via its explicit grant.
- [ ] `tsc` + lint + the full test suite green; `infra/docs/db-role-verification.md` and `.env.example` updated; no secret committed.
- [ ] `billmgmt-progress-tracker.md` updated (bm14 delivered); this spec's decisions recorded there if any were resolved during the build.

## Phase-2 review folds (2026-08-28) — applied inline

The eng-review fixes for this unit are **integrated into the Design / SQL / Verification above** (not appended), so the spec reads as one correct document. Provenance (plan §16):

- **T10** — table `DELETE` on `customer_bill` removed (Step 5 = `SELECT` only); scoped `SECURITY DEFINER` `billrun_delete_trial_bill(run, ban)` added (Step 6b); Design table + the DELETE bullet + guardrail §5 updated.
- **T4** — role-aware `udr_rated` transition trigger (`billrun_status_guard`, `RATED→BILL_DRAFT` only for `billrun_runtime`) added (Step 7b); guardrail §5 "Refused (value)" added.
- **T12** — deploy-ordering self-assert added (Step 0); the "before rating fails loudly" checklist item now cites it.
- **T13** — `app_runtime`'s `customer_bill_tax_item` writes revoked (Step 6a); Design table + guardrail §5 updated.
- Architecture Inv #2 (`billmgmt-architecture.md` §6) synced to the scoped-DELETE + transition-trigger + tax-write-only boundary.
