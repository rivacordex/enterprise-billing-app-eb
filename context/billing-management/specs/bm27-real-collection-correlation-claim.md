# bm27 — Real Collection: Correlation & Claim

**Unit:** bm27 (Phase 3 · Phase L). **Boundary:** `workflow-management/flows/bill-run-processor` (the `validation` + `collection` stages, run as `billrun_runtime`) + `db/bootstrap/billrun-db-roles.sql` (a new read grant) + a boundary guardrail. **The app is untouched** — `handle-stage-signal.ts` stays record-only. **Specs from:** `billmgmt-architecture.md` §6 **Inv #17** (compute in the flow), **Inv #24** (correlate once), **Inv #25 / D32** (unresolvable subscriber), `billmgmt-code-standards.md` §1.2/§1.15, `bm00-build-plan.md` Unit 27. **Model:** `rl.py`'s `_CURRENCY_SQL` (the set-based subscriber→account join).

> **Framing.** This is the first stage that computes against real data. A freshly loaded usage row carries a **subscriber ref, not an account** (`billrun_ban_id` is NULL — bm26). Collection resolves that ref to a billing account through `inventory.product_inventory`, validates the correlated set (currency, window coverage), and **claims** the rows `RATED → BILL_DRAFT`, stamping the six claim columns. Validation folds into this unit because it cannot assert currency or coverage until the correlation exists — and the correlation is computed **once** and shared (Inv #24). An orphaned subscriber is never silently dropped: its row stays `RATED`, unclaimed, visible (D32).

## Goal

Implement the `validation` and `collection` stages of the processing flow so that, for each in-scope account, the flow resolves each `RAN_USAGE` row's `udr_subscriber_ref_id → inventory.product_inventory → billing_account_id` (set-based, computed once), asserts currency and window coverage against that correlated set, and claims the resolved rows `RATED → BILL_DRAFT` stamping the six claim columns — while leaving any unresolvable-subscriber row at `RATED`, unclaimed and untouched.

## Design

**Structural decisions**

- **Correlate once, share with Validation (Inv #24).** The subscriber→account resolution is one set-based query per run, following `rl.py`'s `_CURRENCY_SQL` shape: `udr_rated.udr_subscriber_ref_id = product_inventory.product_inventory_id`, then `product_inventory.billing_account_id`. Validation's currency and window-coverage checks and Collection's claim both read this single correlated set — never two independent resolutions.
- **Claim from `RATED` only (post bm24/bm25).** Collection's claimable set is `status = 'RATED'`, not `('RATED','REJECTED')`. bm24 released reject/rerun rows to `RATED`, and bm25 narrows `billrun_status_guard` to `RATED → BILL_DRAFT`; the stub's old `('RATED','REJECTED')` claim is updated to `RATED` so the flow and the DB guard agree.
- **Claim stamps the resolved account (bm26's NULL filled here).** The `RATED → BILL_DRAFT` claim writes the six columns: `status`, `billrun_ref_id` (the run), `billrun_ban_id` (**the account Collection just resolved**, NULL until now), `billrun_attempt` (`inputs.attempt`, re-stamped so posting's `(run, ban, posted_attempt)` read matches, T6), `billrun_checksum`, `upsert_datetime`. Set-based, whole-account, one statement — never per-record.
- **Unresolvable subscriber is surfaced, not dropped (D32, Inv #25).** A `RAN_USAGE` row whose `udr_subscriber_ref_id` resolves to no `product_inventory` (or to an out-of-scope account) is **left at `RATED`, unclaimed, untouched** — never filtered out silently, never failing the account. It becomes the exception surface's orphan in bm32.
- **Validation asserts against the correlated set.** Currency: `billing_account.currency = udr_currency` (the `_CURRENCY_SQL` check). Window coverage: claimable rows fall within `[period_start, period_end]`. **Zero-claimable is a zero-charge exception, not an error** — the account validates and simply produces no usage lines (recurring may still bill it, bm29).
- **`inventory.product_inventory` is read-only to the flow, and no one writes `billing_account_id` from billing.** `billrun_runtime` gains `USAGE` on the `inventory` schema and `SELECT` on `product_inventory` only. A guardrail asserts nothing on the billing/flow side writes `product_inventory.billing_account_id` — the correlation reads inventory's truth, never mutates it.
- **The real logic lives in the external flow; the app-repo proves it via the flow-double (bm21 pattern).** The `billrun_runtime` correlation/claim SQL ships in the separate workflow-management repo; the `local-dev` flow and the app-repo DB-gated E2E use the flow-double that performs the same `billrun_runtime` writes, so the correlation/claim is testable without a live Kestra.

## Implementation

### 1. Correlation (set-based, once per run)

A single query resolving the run's in-scope claimable rows to accounts, following `_CURRENCY_SQL`:

```sql
-- Resolve subscriber → account for the run's in-scope RATED usage. One statement
-- (Inv #24), shared by Validation and Collection. Rows that fail to resolve
-- (LEFT JOIN NULL) are the D32 orphans — left untouched.
WITH correlated AS (
  SELECT ur.udr_id, ur.partition_period, ur.udr_currency,
         pi.billing_account_id, ba.currency AS account_currency
  FROM   rating.udr_rated ur
  LEFT JOIN inventory.product_inventory pi
         ON pi.product_inventory_id = ur.udr_subscriber_ref_id
  LEFT JOIN billing.billing_account ba
         ON ba.billing_account_id = pi.billing_account_id
  WHERE  ur.is_live AND ur.status = 'RATED'
    AND  ur.udr_type = 'RAN_USAGE'
    AND  pi.billing_account_id = ANY(%(ban_ids)s)   -- in-scope accounts only
)
SELECT * FROM correlated;
```

### 2. Validation stage (folded in) — assert against the correlated set

- **Currency:** any correlated row with `udr_currency <> account_currency` → the account's `validation` stage signals `FAILED` with a `HARD` finding (`CURRENCY_MISMATCH`), the `_CURRENCY_SQL` check applied per account.
- **Window coverage:** correlated rows whose `start_datetime` falls outside `[period_start, period_end]` → `HARD` finding (`WINDOW_COVERAGE`).
- **Zero-claimable:** no correlated rows for the account → `validation` signals `DONE` (a zero-charge exception, not an error); Collection claims nothing; Aggregation writes no usage line.
- The stage signal is the existing record-only `stage/validation/complete` M2M POST (`{ban_id, attempt, status, error_class?, error_code?, error_detail?}`) — no charge payload.

### 3. Collection stage — the real claim

Whole-account, set-based, run as `billrun_runtime`:

```sql
UPDATE rating.udr_rated ur
SET    status = 'BILL_DRAFT',
       billrun_ref_id  = %(bill_run_id)s,
       billrun_ban_id  = c.billing_account_id,   -- the resolved account
       billrun_attempt = %(attempt)s,
       billrun_checksum = %(claim_checksum)s,
       upsert_datetime = now()
FROM   correlated c
WHERE  ur.udr_id = c.udr_id AND ur.partition_period = c.partition_period
  AND  ur.status = 'RATED';                       -- claim from RATED only
```

Rows not in `correlated` (unresolvable subscriber, or out-of-scope) are **not** touched — they remain `RATED`, unclaimed (D32). The `collection` stage then signals `DONE`. The `billrun_status_guard` (bm25, `RATED → BILL_DRAFT`) permits exactly this transition and refuses anything else from `billrun_runtime`.

### 4. Flow files

- **`bill_run_processing.template.yml`** — update the `validation` and `collection` stage contract text: Validation asserts currency + window coverage **against the shared correlated set**; Collection claims **`RATED → BILL_DRAFT`** (drop the `REJECTED` from the stub's `('RATED','REJECTED')`), stamping the resolved `billrun_ban_id`; note the D32 orphan-left-at-`RATED` rule.
- **`local-dev/bill_run_processing.yml`** — replace the Collection/Validation no-op `Log` stubs with the real correlation + claim SQL (a `billrun_runtime` DB task) so the local E2E exercises real resolution against the `ci` seed; other stages stay stubs until their units.
- **`README.md`** — record that Collection/Validation are now real; the remaining `_TBD_` flow-repo/owner lines are unchanged.

### 5. `db/bootstrap/billrun-db-roles.sql` — the inventory read grant

- **Step 3:** add `GRANT USAGE ON SCHEMA "inventory" TO billrun_runtime;` (currently only `billing`/`rating`).
- **Step 8:** extend the enumerated read-context `GRANT SELECT` with `"inventory"."product_inventory"`. No write grant of any kind on `inventory`.

### 6. Guardrails (land with the unit)

- **`product_inventory.billing_account_id` is never written by billing/the flow** — a boundary test (grep/DB-gated) asserting `billrun_runtime` holds no write on `inventory.product_inventory` and no billing-side repository writes that column.
- **Correlation & claim (DB-gated, on the `ci` seed):** trigger a run — rows whose `billrun_ban_id` was NULL are claimed to the correct accounts (`BILL_DRAFT`, `billrun_ban_id` resolved); an orphaned-subscriber row is left `RATED` and unclaimed; a currency-mismatched account fails Validation `HARD`; a zero-claimable account validates `DONE` with no claim.

## Dependencies

- **No new npm packages.**
- **Prerequisites:** bm23 (schema present for the downstream bill the claim feeds), bm24 (reject/rerun release to `RATED`, so `RATED`-only claim is complete), bm26 (`RAN_USAGE` rows with NULL `billrun_ban_id` to resolve). bm25 narrows `billrun_status_guard` to `RATED → BILL_DRAFT` — land it with or before this unit so flow and guard agree.
- **Prereq data:** `inventory.product_inventory` populated with `billing_account_id` (delivered; the `ci` seed's real order path fills it).

## Verification checklist

- [x] Correlation is one set-based query per run (Inv #24), shared by Validation and Collection; it follows the `_CURRENCY_SQL` join `udr_subscriber_ref_id → product_inventory → billing_account`.
- [x] Collection claims `RATED → BILL_DRAFT` only, stamping the six columns incl. the **resolved** `billrun_ban_id`; the `billrun_status_guard` permits exactly this and refuses any other `billrun_runtime` transition.
- [x] An unresolvable-subscriber row is left `RATED`, unclaimed and untouched (D32) — never filtered, never failing the account.
- [x] Validation asserts currency + window coverage against the correlated set; a mismatch fails `HARD`; zero-claimable is a zero-charge `DONE`, not an error.
- [x] `billrun_runtime` has `USAGE` on `inventory` + `SELECT` on `product_inventory`, and **no** write on either; the guardrail proves nothing writes `product_inventory.billing_account_id`.
- [x] On the `ci` seed, a triggered run claims the previously-NULL `billrun_ban_id` rows to the right accounts; `tsc`/lint/tests green; `billmgmt-progress-tracker.md` records bm27 delivered. *(The DB-gated flow-double `tests/db/billrun-collection-correlation.integration.test.ts` proves the correlation/claim against a focused fixture equivalent to the `ci` seed's real order path; a live `ci`-seed run against a deployed Kestra remains in the module's standing live-Kestra smoke gate — see the progress tracker's Outstanding.)*
