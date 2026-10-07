# Billing Management — Bill Run — Target Capacity Pricing Update Overview

_Date: 2026-10-04 · Users: Revenue Operations (RevOps, in-app) and BSS Ops (Kestra engine + deploy layer). Derived from `_updatemodule-billing-billrun-target-capacity-plan.md`. The delivered Phases 1–4 (bm01–bm39) current-state lives in `billmgmt-project-overview.md`._

> **Status (bm46, 2026-10-07): delivered.** Units bm40–bm45 shipped this
> update's full design below; bm46 (the ship gate) audited it against
> guardrails 36–42 and invariants #29–#38, confirmed no migration beyond
> bm41's `0044`, and folded the delivered narrative into
> `billmgmt-project-overview.md`. **Outstanding:** the live-Kestra capacity
> journey (TC54) and the DB-gated capacity suites have not been run against a
> live Postgres/Kestra stack in this checkout's environment; **O-TC7**
> (partial-period capacity billing) remains an open business decision. See
> `billmgmt-progress-tracker.md` for both.

## Overview

The Billing Management module runs monthly bill runs for the Revenue Operations team: it materialises a `bill_run` per cycle, claims each account's already-rated usage from `rating.udr_rated`, derives recurring charges from `inventory.product_inventory`, assembles a draft bill (`customer_bill` + `customer_bill_line`), approves it under a four-eyes gate, posts one `INV` document per account into pgledger through the Accounts engine, renders and stores the invoice PDF, and distributes invoices plus the run report over SFTP. This update adds **target-capacity pricing** for RAN_USAGE offerings — a **commitment floor** (an account that uses less than its committed quantity is billed as if it used the target) and a **motivation discount** (usage above the target is billed at a lower per-unit rate, the difference recorded as a discount) — applied after aggregation at billing-account level as inline SQL in the existing `bill_run_processing` flow, and adds a **per-polygon invoice usage appendix** grouped by state and district. Because a recent product change (PC14) reshaped `product_offering_price` into one row per component, the bill run's recurring resolver no longer matches the schema and fails every account; this update first repairs that (Unit 0, a live P0) before any capacity logic lands. It depends on the finalized `_change-rating-configuration-plan.md` (PER_UNIT rating, the `udr_subscription_ref_id` rename, the real subscriber resolver), treated as shipped by the time this phase's build specs are written.

## Goals

1. **Repair the bill run onto the component price model (Unit 0, live P0).** Rewrite the bm29 RECURRING resolver off the removed `pop.amount`/`pricing_model`/`price_type` columns onto `component_type` + `price_component jsonb`; build one shared as-of component reader partitioned by `(product_offering_id, component_type, unit_of_measure)`; remove the dead tiered branch; replace the hand-copied test double with a harness that extracts and runs the flow's real SQL. Ship it as its own PR, deployed first.
2. **Apply the commitment floor.** For a capacity offering, bill `max(Q, target) × baseRate` when usage `Q` is at or below target — a top-up of `(target − Q) × baseRate` fills the gap to the committed quantity, even at zero usage.
3. **Apply the motivation discount.** Bill usage above the target at the lower step rate; record the saving as `discount_amount = overage × (baseRate − stepRate)`, with `gross` at the base rate and `net = gross − discount`.
4. **Compute it in one transaction, verified independently.** All capacity logic is inline SQL CTEs in the existing psql `aggregation` step, in the same whole-account-replace transaction that writes the bill (Model 1, anchored on `Σ udr_rated_price`). Verification carries an independent volume-based cross-derivation (Model 2, `max(Q,target) × baseRate`) gated by the `CAPACITY_RATE_MATCHING` flow variable.
5. **Guard every mis-configuration as a loud, account-level HARD failure.** Six codes fail only their own account (`PROCESSING_FAILED`, skippable/rerunnable) while every sibling account keeps billing.
6. **Extend verification and the posting checksum, and store a calculation trace.** Reconcile each USAGE line against `rated_amount`; append `rated_amount` to the `charge_checksum` tuple; write an `additional_info` calc trace (pricing inputs, per-operation math, a pre-rendered summary) on every capacity line.
7. **Render a per-polygon invoice usage appendix.** The posted invoice lists every polygon's usage for the month, grouped by state then district, with state/district joined from the ratecard named by the product's `productCardLookUp` spec.
8. **Keep multi-step motivation roadmap-ready.** The SQL and tests are N-band; a `capacity_max_bands` flow input (default 1) blocks more than one band in production, so enabling multi-step later is a config change, not a pricing-SQL edit.

## Core user flow

1. **Materialise.** RevOps opens Billing → Bill Runs; the page lazily inserts the current period's `bill_run` (`SCHEDULED`). No scheduler. (Unchanged.)
2. **Trigger.** A `billrun_operate` user clicks Run. The app snapshots eligible accounts into `bill_run_account`, sets the run `PROCESSING`, and triggers Kestra execution #1. (Unchanged.)
3. **Collection.** Per account, the flow claims the account's `RAN_USAGE` rows `RATED → BILL_DRAFT`, correlating each via `udr_subscription_ref_id = product_inventory_id → billing_account_id`. (Rename from `udr_subscriber_ref_id` ships with the rating-config dependency.)
4. **Aggregation — capacity pricing (new).** For an account holding a capacity offering (detected by a `capacity_commitment` or `capacity_motivation` component, not by a column):
   - resolve the base `usage_rate`, `capacity_commitment` and `capacity_motivation` components off the subscription's **pinned** offering version (via `product_inventory → order_item` — the same version rating priced from);
   - compute `rated_amount = Σ udr_rated_price`, `topUp = round(max(target − Q, 0) × baseRate)`, `gross = rated_amount + topUp`, `discount = Σ round(bandQty × (baseRate − stepRate))`, `net = gross − discount`;
   - write one `customer_bill_line` per `(offering, unit_of_measure)` — `source 'USAGE'`, `udr_type` the offering's spec `udrType`, `grouping_key <offering>:CAPACITY:<unit>` — generated from the active subscription even at zero usage, carrying the money columns, `rated_amount`, `discount_rate`/`discount_amount_raw`, and an `additional_info` calc trace;
   - a mis-configured account HARD-fails one of the six guards, settles to `PROCESSING_FAILED`, and every other account keeps processing.
5. **Verification.** Each USAGE line replays `SUM(udr_rated_price) = rated_amount`; each capacity line is checked for `gross = rated_amount + topUp` and `net = gross − discount`, and reconciled against the independent Model-2 recompute. `CAPACITY_RATE_MATCHING` (default ON) HARD-fails a rating-vs-bill-run rate mismatch with a diagnostic naming both rates and both version sources; set OFF, it downgrades to a logged WARN, bills Model 1's number, and records the flag state on the run.
6. **Review.** RevOps opens Customers & Bills: the capacity line appears as the invoice's face, its `udr_rated` rows as per-subscription drill-down, and the motivation discount in the line's discount column. (The capacity calc trace stays database-only.)
7. **Approve → Post → render.** A second `billrun_approve` user approves; the run posts one `INV` per account and renders the invoice PDF. **The PDF now carries a usage appendix**: every polygon that contributed usage in the month, grouped by state then district (state/district joined per cell from the `productCardLookUp` ratecard), with per-district, per-state and line totals.
8. **Distribute → Complete.** The app triggers Kestra execution #2; each artifact is downloaded and SFTP'd; the run reaches `COMPLETED`. (Unchanged.)
9. **Partial periods.** An account with a mid-period start, cease or suspension is `EXCLUDED` at scoping and produces no capacity bill that month (its usage stays `RATED`, unclaimed); it resumes at the next full cycle. No proration is built.

## Features

### Unit 0 — schema repair & test harness

- Recurring resolver rewritten onto `component_type = 'flat_fee' AND price_component->>'priceType' = 'recurring'` and `(price_component #>> '{params,amount}')::numeric`; the shared as-of component reader; the dead tiered-pricing branch removed.
- The hand-copied `tests/db/helpers/billrun-aggregate.ts` double replaced by a harness that parses `bill_run_processing.yml`, strips the Kestra `{{ }}` templating, rebinds the GUCs, and runs the real step heredocs in one transaction — so tests can no longer drift from the deployed flow.
- A fail-closed destructive-DB preflight (explicit opt-in + a disposable sentinel, run before any DB client import) and removal of the cross-cluster `DROP DATABASE … WITH (FORCE)`.

### Capacity aggregation

- Commitment floor and motivation discount computed as inline SQL CTEs in the `aggregation` step, as `billrun_runtime`, in the per-account whole-account-replace transaction.
- Capacity line identity `(offering, unit_of_measure)`; generated from the subscription even at zero usage; N-band SQL with a single-band `capacity_max_bands` guard.
- Each monetary component rounded once (2 dp, HALF_UP); `gross` and `net` derived from the rounded parts, never re-rounded, so the identities hold with no ±0.01 tolerance.

### Account-level guards (HARD, per account)

- `CAPACITY_MULTIPLE_SUBSCRIPTIONS` — more than one subscription of the same capacity offering family on the account.
- `CAPACITY_BASE_RATE_NOT_FOUND` — a modifier present with no same-unit `usage_rate` to price from.
- `CAPACITY_UDR_TYPE_MISMATCH` — a claimed row whose `udr_type` ≠ the spec `udrType`.
- `CAPACITY_RATE_MISMATCH` — a claimed row priced at a rate other than the resolved `ratePerUnit` (`IS DISTINCT FROM`, so a NULL rate counts); gated by `CAPACITY_RATE_MATCHING`.
- `CAPACITY_MULTI_STEP_UNSUPPORTED` — a motivation schedule with more than one band (production is single-band this phase).
- `CAPACITY_CURRENCY_MISMATCH` — the resolved component currency ≠ the account currency.

### Verification, checksum & calc trace

- USAGE-line replay reconciles against `rated_amount` (not `gross_amount`); capacity lines reconcile `gross = rated_amount + topUp`, `net = gross − discount`, and an independent Model-2 recompute; a tamper is caught by both the internal identity and the Model-2 cross-derivation.
- The posting `charge_checksum` **appends** `rated_amount` as the last tuple element, preserving the delivered field order; `additional_info` is not hashed.
- `additional_info` carries `pricing` (the resolved price rows), `calc` (the ordered operations) and a pre-rendered `summary[]`; it is database-only (the invoice renders the usage appendix, not this trace).

### Invoice usage appendix

- The posted invoice lists per-polygon `udr_rated` records for the billing month, grouped by state then district, with state/district joined from the `productCardLookUp` ratecard (they are not on `udr_rated`).
- Per-polygon only (no district summarisation), bounded to ≤ 10,000 rows per account this phase and load-tested to that bound; a polygon with usage but no matching ratecard row is surfaced, not dropped.

### Configuration

- `CAPACITY_RATE_MATCHING` (flow variable, default ON) — the rate-match gate: ON hard-fails a mismatch, OFF logs a WARN and bills Model 1 while recording the flag state.
- `capacity_max_bands` (flow input, default 1) — the single-band production guard; raising it enables the already-built N-band path.

### Data model, access & seeds

- `billing.customer_bill_line` gains `rated_amount numeric(18,2)` (NULL for RECURRING; `= gross_amount` on non-capacity USAGE) and `additional_info jsonb` (capacity lines only). One migration; no other schema change.
- `billrun_runtime` gains `SELECT` on `product.product_specifications` (read the `udrType` characteristic) and, for the appendix, `product.ratecard_ran_usage_lkp` + `ratecard_version`.
- The `_SAMPLE_` seed carries a fixture per test scenario, including a multi-polygon, multi-state/district capacity account.

## In scope

- Unit 0: the component-model repair, the shared as-of reader, the dead-branch removal, and the extracted-SQL test harness (+ the destructive-DB preflight).
- Capacity aggregation: commitment floor + motivation discount as inline SQL; the capacity line at `(offering, unit)`, generated even at zero usage; N-band SQL with the single-band `capacity_max_bands` guard.
- The six HARD account-level guards.
- Verification (`rated_amount` replay + the Model-2 cross-derivation) and the `charge_checksum` re-anchor appending `rated_amount`.
- The `additional_info` calc trace (database) and the per-polygon invoice usage appendix by state/district (PDF).
- The two new `customer_bill_line` columns + Drizzle mirror; the `billrun_runtime` grants; the seed fixtures.
- The `CAPACITY_RATE_MATCHING` and `capacity_max_bands` flow configuration.

## Out of scope

- **Proration / partial-period billing** — partial-period accounts stay `EXCLUDED`; whether those months should bill, and how to prorate the floor, is an unresolved **business** decision, not an engineering deferral.
- **Multiple billing accounts per customer for the same capacity product** — one account per product per customer this phase; the rating resolver is customer-grain.
- **Negotiated overrides on capacity offerings** — enforced out by the rate-mismatch guard, not built.
- **Rate-card item pricing** — a card with per-item rates is incompatible with a single base rate this phase; the card is validation/mapping/fields only (`rate_per_unit` stays NULL).
- **Multi-step motivation in production** — the N-band code and tests exist, but `capacity_max_bands` blocks more than one band.
- **Any display of the capacity calculation trace** (`calc`/`summary`) — database-only; only the per-polygon usage appendix renders. No bill-line-table or draft-preview change.
- **A per-polygon appendix beyond 10,000 rows per account, or summarised by district** — bounded and per-polygon only this phase.
- **Real taxation** — the ratified `0.00` interim stands (`total = subtotal`).
- **The product / inventory / ordering changes** (`max_instances_per_billing_acc`, the `udrType`/`productCardLookUp`/`singleSubInstPerCust` specs, the order-time guard) — a separate prerequisite phase.

## Success criteria

1. On the `_SAMPLE_` `ci` seed (base rate 100, committed 1000, motivation >1000 @ 50, unit EA): usage 800 bills `net 100,000` (rated 80,000 + top-up 20,000); 1000 bills `100,000`; 2000 bills `net 150,000` (gross 200,000 − discount 50,000); 0 bills `100,000` (full floor). `subtotal = SUM(net_amount)`.
2. Each of the six guards fails only its own account (`PROCESSING_FAILED`, rerunnable) while sibling accounts bill; a NULL/`ZERO_RATED` rate trips `CAPACITY_RATE_MISMATCH` (proving `IS DISTINCT FROM`).
3. On a rating-consistent run the Model-2 cross-derivation reconciles with the stored `gross`/`discount`; a mismatch HARD-fails under `CAPACITY_RATE_MATCHING=ON` with a diagnostic naming both rates, and under `=OFF` downgrades to a logged WARN, bills Model 1, and records the flag state.
4. Verification catches a tampered `rated_amount`/`gross`/`discount`/`calc.total` via both detectors; every capacity line holds `discount_amount ≥ 0` and `net_amount ≥ 0`.
5. The posted invoice renders the per-polygon usage appendix grouped by state and district, with state/district joined from the `productCardLookUp` ratecard, load-tested to 10,000 polygon rows per account; a polygon absent from the card is surfaced, not dropped.
6. A rerun reproduces identical lines and `line_no` (whole-account replace).
7. The deployed, pebble-rendered flow drives a capacity account `SCHEDULED → COMPLETED` on the `_SAMPLE_` `capacity` seed (the seeder's dedicated capacity-offering profile — `ci` has no capacity accounts) through a real Kestra execution, not only the extracted-SQL harness — this needs a capacity-aware live-Kestra smoke path, since `scripts/billrun-live-kestra-smoke.ts` today only drives the `ci` profile; Unit 0's existing aggregation/recurring/volume/verification/checksum suites pass against the PC14 schema.
8. No new migration beyond the one adding `rated_amount` + `additional_info`; `npm run typecheck`, `npm run lint`, and the vitest suite pass; the owning docs (`billmgmt-architecture.md`, `billmgmt-code-standards.md`, `billmgmt-progress-tracker.md`) are synced.
