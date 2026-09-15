# bm29 — Real Aggregation (`RECURRING`) + Price Resolver

**Unit:** bm29 (Phase 3 · Phase L). **Boundary:** the processing flow's `aggregation` stage (recurring path, run as `billrun_runtime`) + `db/bootstrap/billrun-db-roles.sql` (pricing read grants) + the Customers & Bills read path (`ChargeSourceBadge`). **New billing compute — not a reuse of rating's `rp.py`.** **Specs from:** `billmgmt-architecture.md` §6 **Inv #1** (recurring is billing, not rating), **Inv #16** (source-specific exactly-once), **Inv #20 / D19** (price snapshot authoritative on rerun), **Inv #28 / D33** (unresolvable/tiered fails HARD), `billmgmt-code-standards.md` §4 (`ChargeSourceBadge`), `bm00-build-plan.md` Unit 29.

> **Framing.** Usage comes from `udr_rated` (bm28); **recurring comes from subscriptions**. This unit adds a **new recurring price resolver** in the flow that reads each subscription's offering price as-of the run's period, maps the recurring charge period onto the bill cycle, multiplies by the subscription quantity, and writes `RECURRING` `customer_bill_line` rows — with a **price snapshot** so a rerun reproduces the original amounts even after a backdated price change. It is new billing compute, deliberately **not** rating's `rp.py` (which is usage-only and refuses `tiered`), and it runs in the flow, never under `services/billing/**` (Inv #17). Aggregation is split by source (bm28 USAGE / bm29 RECURRING) because each has a different exactly-once mechanism and a different failure mode.

## Goal

Resolve each subscription's recurring price as-of the run period (flat `product_offering_price` with an `order_item_price_override` fallback), map its charge period onto the bill cycle, multiply by `product_inventory.quantity`, and write `RECURRING` `customer_bill_line` rows (one per offering, rolled across subscriptions) with a stored price snapshot read-not-re-resolved on rerun — failing only the affected account HARD (`RECURRING_PRICE_NOT_FOUND` / `RECURRING_PRICE_UNSUPPORTED`) when a price is missing or `tiered`, and badging each line's source in the UI.

## Design

**Structural decisions**

- **New compute, not `rp.py` (Inv #1/#17).** `rp.py` resolves usage prices only and lets a `tiered` row fall out as a lookup miss; recurring billing needs a positive charge or a hard failure. bm29 is a fresh resolver in the flow, running as `billrun_runtime` — no `services/billing/**` code computes it.
- **As-of resolution with override fallback (flat only).** For each subscription, resolve `product.product_offering_price WHERE price_type = 'recurring' AND pricing_model = 'flat'` as-of the run basis, using the `lead(start_date_time) OVER (PARTITION BY offering, price_type ORDER BY start_date_time)` `[eff_from, eff_to)` window; `COALESCE` an `ordering.order_item_price_override` (`price_type = 'recurring'`, keyed by `product_order_item_id`) over the catalog `amount`. Map `recurring_charge_period_length`/`_type` onto the bill cycle frequency (`monthly`/`quarterly`/`annually`), then multiply by `product_inventory.quantity` (`>= 1`).
- **Price snapshot, read-not-re-resolved on rerun (Inv #20, D19).** Each `RECURRING` line stores its snapshot (`snapshot_price_ref`, `snapshot_unit_price`, `snapshot_quantity`, `snapshot_effective_date`, bm23). On (re)aggregation, the resolver **reads any existing `RECURRING` line snapshot for the account before the whole-account replace deletes it**, and reuses it where present; as-of resolution runs **only when no snapshot exists** (first derivation, or a reject that dropped the bill). So a rerun after a backdated `product_offering_price` insert reproduces the **original** amounts — the `lead()` window is never re-walked for an already-reviewed period.
- **Same whole-account replace, split by source (Inv #16).** RECURRING lines are written in the same `billrun_delete_trial_bill` + re-insert transaction as USAGE (bm28); `subtotal = SUM(net_amount)` now spans both sources. USAGE's exactly-once is the claim; RECURRING's is the whole-account replace — different mechanisms, one physical re-derivation. Grain: one `RECURRING` line per `(product_offering_id)` (`udr_type` NULL), rolled across subscriptions of that offering.
- **D33: unresolvable or tiered fails the account HARD (Inv #28).** A missing as-of `recurring` price, or a `pricing_model = 'tiered'` subscription (the flat resolver can't rate it), sends **that account only** to `PROCESSING_FAILED` with a `HARD` finding and `RECURRING_PRICE_NOT_FOUND` / `RECURRING_PRICE_UNSUPPORTED` (free-string `error_code`). Never substitute zero, never skip a subscription silently; every other account stays billable.
- **`ChargeSourceBadge` (cyan `USAGE` / primary `RECURRING`).** A `cva` badge mirroring `bill-category-badge.tsx`, on each `BillLineTable` row. A `RECURRING` row shows its **price snapshot in the disclosure slot** (no per-record `udr_rated` drill-down — it has none).

## Implementation

### 1. The recurring price resolver (`billrun_runtime`, in the flow)

Per account, resolve each subscription's recurring price and aggregate to lines:

```sql
-- Read the prior snapshot BEFORE the whole-account replace (Inv #20) — reuse on
-- rerun; resolve as-of only where no snapshot exists.
WITH prior AS (
  SELECT ref_product_offering_id, snapshot_price_ref, snapshot_unit_price,
         snapshot_quantity, snapshot_effective_date
  FROM   billing.customer_bill_line l
  JOIN   billing.customer_bill b ON b.customer_bill_id = l.ref_customer_bill_id
                                 AND b.period_partition = l.period_partition
  WHERE  b.ref_bill_run_id = %(bill_run_id)s AND b.ref_billing_account_id = %(ban)s
    AND  l.source = 'RECURRING'
),
asof AS (  -- flat recurring price as-of the run basis, override COALESCE'd
  SELECT pi.product_offering_id,
         COALESCE(oipo.amount, pop.amount)        AS unit_price,
         COALESCE(oipo.order_item_price_override_id, pop.product_offering_price_id) AS price_ref,
         pop.pricing_model, pop.start_date_time   AS effective_date,
         pi.quantity, pi.product_order_item_id
  FROM   inventory.product_inventory pi
  JOIN   product.product_offering_price pop
         ON pop.product_offering_id = pi.product_offering_id
        AND pop.price_type = 'recurring'
        AND pop.start_date_time <= %(as_of)s
        AND (lead(pop.start_date_time) OVER (PARTITION BY pop.product_offering_id, pop.price_type
                                             ORDER BY pop.start_date_time) > %(as_of)s
             OR lead(pop.start_date_time) OVER (...) IS NULL)
  LEFT JOIN ordering.order_item_price_override oipo
         ON oipo.product_order_item_id = pi.product_order_item_id
        AND oipo.price_type = 'recurring'
  WHERE  pi.billing_account_id = %(ban)s
)
-- D33: if a subscription has no asof row (missing price) or pricing_model='tiered',
-- fail this account HARD (RECURRING_PRICE_NOT_FOUND / _UNSUPPORTED) — do not insert.
-- Otherwise insert one RECURRING line per offering: net = SUM(COALESCE(prior.unit_price,
-- asof.unit_price) * quantity), snapshot = prior where present else asof.
```

The line write shares the bm28 INSERT into `customer_bill_line` (`source = 'RECURRING'`, `line_type = 'charge'`, `udr_type` NULL, deterministic `line_no` over the shared `grouping_key`), and the snapshot columns are populated from `prior` (rerun) or `asof` (first derivation).

### 2. Flow files

- **`bill_run_processing.template.yml`** — extend the `aggregation` contract: after USAGE, resolve recurring prices as-of, map the charge period onto the cycle, × quantity, snapshot-read-on-rerun, and the D33 HARD-fail branch.
- **`local-dev/bill_run_processing.yml`** — the recurring resolver SQL (or flow-double) so the local E2E bills the `ci` recurring-only and mixed accounts.

### 3. `db/bootstrap/billrun-db-roles.sql` — pricing read grants

- **Step 3:** add `GRANT USAGE ON SCHEMA "ordering" TO billrun_runtime;` if not already granted (product USAGE landed in bm28, inventory in bm27).
- **Step 8:** extend the enumerated read grant with `"product"."product_offering_price"`, `"ordering"."order_item_price_override"` (and `"ordering"."product_order_item"` if the override join needs it). No write on `product`/`ordering`.

### 4. D33 failure path

When a subscription resolves to no as-of `recurring` price, or its price is `pricing_model = 'tiered'`, the flow signals the account's stage `FAILED` with `error_class = 'HARD'` and `error_code = 'RECURRING_PRICE_NOT_FOUND'` / `'RECURRING_PRICE_UNSUPPORTED'` — `advanceAccountStatus` moves it to `PROCESSING_FAILED` (bm04 path, unchanged), no bill produced for it. Other accounts complete normally. Fixing the catalog + a rerun re-derives it.

### 5. UI — `ChargeSourceBadge`

- **`components/billing/charge-source-badge.tsx`** (new) — a `cva` badge mirroring `bill-category-badge.tsx`: `USAGE` → cyan (`--color-info-*`), `RECURRING` → primary (`--color-primary-*`); `OCC` reserved/unrendered. Rendered on each `BillLineTable` row (uses the `ChargeSource` union added in bm28).
- **`BillLineTable`** — a `RECURRING` row's disclosure shows its price snapshot (ref, unit price, quantity, effective date); no `udr_rated` drill-down for recurring.

## Dependencies

- **No new npm packages.**
- **Prerequisites:** bm28 (USAGE aggregation, `customer_bill_line` write via the whole-account replace, `subtotal = SUM(net_amount)`, `BillLineTable`, the `ChargeSource`/`LineType` unions). `product.product_offering_price`, `ordering.order_item_price_override`, `inventory.product_inventory` populated (delivered; the `ci` seed's recurring-only and mixed accounts exercise it).

## Verification checklist

- [ ] A recurring-only account produces a non-empty bill with subscription charges and no usage; an account with both shows one line per `(offering, udr_type)` with `USAGE`/`RECURRING` badges.
- [ ] The resolver reads `product_offering_price` (flat, as-of `lead()` window) with an `order_item_price_override` fallback, maps the recurring period onto the bill cycle, and multiplies by `quantity`.
- [ ] A rerun after a backdated `product_offering_price` insert reproduces the **original** amounts (snapshot read before the whole-account replace; never re-resolved).
- [ ] A `tiered` subscription fails its own account (`RECURRING_PRICE_UNSUPPORTED`, HARD → `PROCESSING_FAILED`) and leaves every other account billable; a missing price fails `RECURRING_PRICE_NOT_FOUND`; never zero-substituted or silently skipped.
- [ ] `billrun_runtime` has `SELECT` on `product.product_offering_price` + `ordering.order_item_price_override` (and USAGE on `ordering`); no write on `product`/`ordering`.
- [ ] `ChargeSourceBadge` renders per line; a `RECURRING` row's disclosure shows its price snapshot; `tsc`/lint/tests green; guardrails pass on the `ci` seed; `billmgmt-progress-tracker.md` records bm29 delivered.
