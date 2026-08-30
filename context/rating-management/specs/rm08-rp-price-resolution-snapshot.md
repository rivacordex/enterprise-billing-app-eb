# rm08 — RP: price resolution and snapshot — Spec

- **Unit:** rm08 of rm01–rm13 (`specs/rm00-build-plan.md`, Phase D)
- **Repo:** rating repo · **Boundary:** `flows/**` — the `rp` section (replaces the rm06 stub)
- **Builds:** event-time (as-of) price resolution through the pinned `product_offering` version with any override applied, snapshot-on-first-rate, the `FLAT` calculation (full enum defined, non-`FLAT` unimplemented), the raw + rounded price, `udr_currency`, and the version stamps.
- **Depends on:** rm03 (`SELECT` on `product`/`ordering`/`inventory`/`billing`; `EXECUTE` on `rating.period_of`), rm07 (validated records + the profile's subscriber-ref mapping, if any).
- **Config introduced:** rounding mode (v1: a single **flow variable**) — per `rm00` §Configuration.
- **Sources:** `rm00-build-plan.md` Unit rm08 + **Open item 2** · `ratemgmt-code-standards.md` §6 (price-resolution standards), §2.2 (money carve-out), §5.9 (money columns) · `_newmodule-rating-engine-plan.md` §4.5 (money/rounding), §4.6 (rate types), §4.8 (codebase findings) · `ratemgmt-architecture.md` Inv #2, #12, #13.

> **Codebase-grounded (verified 2026-08-26) and resolves Open item 2 → (b) the SQL as-of predicate.** The effective-dated price chain, the `LEAD()` end-bound, and the `isEffectiveNow` `[start, end)` semantics were read from `db/schema/{product,ordering,inventory,billing}.ts`, `db/repositories/product-offering-price.ts`, and `services/ordering/get-order-detail.ts`. Confirmed: `product_offering_price` has `start_date_time` and a bare-`numeric` `amount`, no end column (derived by `LEAD` over `PARTITION BY (product_offering_id, price_type)`); `order_item_price_override` has **no temporal columns** and overrides `amount` per `(product_order_item_id, price_type)`; the **pinned offering version** is the immutable `product_offering_id` FK the order item carries; `product_inventory` is 1:1 with `product_order_item` and denormalises `billing_account_id`.

---

## Goal

Replace the `rp` stub with **event-time price resolution**: for each validated record, resolve — via a **SQL as-of predicate** — the price effective at `start_datetime` through the subscription's **pinned** `product_offering` version, apply any `order_item_price_override`, **snapshot** the resolved inputs onto the row, compute the `FLAT` charge (both raw and rounded), and stamp the version columns — so a record re-rated after the catalog price *and* the override change reproduces the original amount.

---

## Design

### D1. The SQL as-of predicate (Open item 2, resolved → b)

Resolution is a **set-based SQL join** — one query per chunk, not the existing pull-all-and-filter-in-JS pattern (code-standards §5.3 forbids it at 50k records). The effective window is the `LEAD` derivation translated into a **WHERE predicate**, matching `isEffectiveNow`'s `[start, end)` semantics **exactly** (start inclusive, end exclusive):

```sql
eff_from <= :event_time AND (:event_time < eff_to OR eff_to IS NULL)
```

A record whose `start_datetime` falls **exactly** on a price boundary resolves to the **new** price (start inclusive), identical to the app's existing semantics.

### D2. The resolution chain (concrete, from the schema)

From a subscription identity to the effective price + override:

```text
inventory.product_inventory (product_inventory_id)
  → 1:1  ordering.product_order_item (product_order_item_id)
  → pin  product.product_offering (product_offering_id — the IMMUTABLE, grandfathered version)
  → many product.product_offering_price (price_type='usage'), as-of at start_datetime
  ⊕ 0..1 ordering.order_item_price_override (per product_order_item_id, price_type)
```

**Resolve through the pinned version, never the current offering** (code-standards §6.1): the order item's `product_offering_id` FK *is* the price snapshot (grandfathering). `effective_amount = COALESCE(override.amount, price.amount)`. `udr_currency` comes from the **resolved price row** (D9).

### D3. The record → subscription link is config (feed profile)

rm08 resolves from `udr_subscriber_ref_id`, which rm07's **feed profile** populates from a key column *only where the profile declares a subscriber-ref mapping* (rm07 D1). `udr_subscriber_ref_id` is (or resolves to) a `product_inventory_id`. **For the `RAN_USAGE` sample the subscriber resolver is a profile config to set at build** — the engine does not assume which key dimension is the subscriber. A record whose subscriber/offering does not resolve raises **`LOOKUP_MISS`** at `MAJOR`; it is not rated.

### D4. Snapshot-on-first-rate — mandatory, not an optimisation

RP writes the resolved inputs **onto the row** (code-standards §6.2): `udr_usage_rate` (the resolved rate/amount), `udr_price_ref` (`product_offering_price_id`), `udr_price_effective_date` (the price row's `start_date_time`), `udr_price_override_ref` (`order_item_price_override_id`, when applied), and `udr_rounding_mode`. This is **mandatory**: `order_item_price_override` carries **no temporal columns** (confirmed), so an override added in October would otherwise retroactively change what August re-rates to. **Re-rating reads the snapshot, never re-resolves against product data** — that is the property behind test #13.

### D5. `FLAT` calculation; the enum defined, non-`FLAT` unimplemented (v1)

`udr_rate_type = FLAT` only in v1 (project scope; engine plan §4.6): the charge is the **flat amount, quantity ignored** — so `USAGE_MBPS`/`udr_usage_quantity` is stored (rm07) but **not** used by the `FLAT` calc. `udr_rated_price_raw` = `effective_amount` at full precision (`numeric(18,6)`); `udr_rated_price` = round to `numeric(18,2)`. `PER_UNIT`, `TIERED_GRADUATED`, `TIERED_VOLUME`, `BLOCK`, `PERCENTAGE`, `ZERO_RATED` exist in the enum and the `udr_rate_detail` schema, but their **calculation is a `# STUB:`** (comments) — a later phase and a spec change, not this unit (ai-workflow-rules §3.1).

### D6. `udr_rate_detail` JSONB, typed and discriminated

Typed via `.$type<T>()` where `T` is `z.infer` of the discriminated union in `validation/rating/udr-rate-detail.schema.ts` (declared with rm01's column), keyed on `udr_rate_type` (code-standards §2.3). The `FLAT` variant is minimal (no band data). Adding `BLOCK`/tiering later is a validation-schema change, not a migration.

### D7. Rounding — per-record method (the sync decision D-A)

`udr_rounding_mode ∈ {HALF_UP, HALF_EVEN, TRUNCATE}` — the **per-record rounding method**. RP rounds **once, per record** (code-standards §2.2). Round-at-aggregation is the bill run's stage, out of scope. v1 ships **one** rounding value as a **flow variable** (rm00 §Configuration); `udr_rounding_mode` is still stamped per row so the record stays self-describing.

### D8. Money carve-out — full-precision `Decimal`, rounded once

The catalog `amount` is a **bare `numeric`** (confirmed) and can carry arbitrary decimals; rates are `numeric(18,6)`. Rating computes at **full precision in Python `Decimal`** — **never `float`**, and **not** through `services/accounts/money.ts` (which works in integer sen and throws `MoneyPrecisionError` above 2 dp). It rounds **once** per `udr_rounding_mode`, stores both `udr_rated_price_raw` and `udr_rated_price`, and only the rounded `numeric(18,2)` value is ever handed onward (code-standards §2.2).

### D9. Currency from the resolved price row

`udr_currency` (`char(3)`) is taken from the **resolved `product_offering_price.currency`**. The **`CURRENCY_MISMATCH`** assertion — that it equals `billing_account.currency` via `product_inventory.billing_account_id` — is **RL's** (rm09), not rm08's. rm08 only stamps `udr_currency`.

### D10. Version stamps (Inv #12)

RP stamps `rated_datetime`, `rating_engine_version` (from the `RATING_ENGINE_VERSION` env the Container App injects, rm04 D6), and `rating_flow_revision` (the Kestra flow revision). Both version columns are stored on every row because rating logic lives in both artefacts; neither alone reconstructs a historical charge.

### D11. Chunked, typed handoff — no per-record fan-out

RP reads PRP's **Parquet** chunks, runs **one as-of query per chunk** (the records joined set-based against the price chain), computes in `Decimal`, and emits a rated Parquet chunk for RL. No task fans out per record (Inv #10).

---

## Implementation

### 1. The `rp` flow section (replaces the stub)

Replace the `# STUB: rm08` section of `flows/ran-usage-rating.yaml` with a Python `Commands`/`Script` task calling `rp.py`. Handoff by file URI (Parquet) both ways.

### 2. The as-of resolution query (`rp.py`, one per chunk)

```sql
WITH price_windows AS (
  SELECT popp.product_offering_id, popp.price_type, popp.product_offering_price_id,
         popp.amount, popp.currency, popp.pricing_model,
         popp.start_date_time AS eff_from,
         lead(popp.start_date_time) OVER (
           PARTITION BY popp.product_offering_id, popp.price_type
           ORDER BY popp.start_date_time) AS eff_to
  FROM product.product_offering_price popp
  WHERE popp.price_type = 'usage'
)
SELECT r.udr_id,
       pw.product_offering_price_id      AS udr_price_ref,
       pw.eff_from                       AS udr_price_effective_date,
       pw.currency                       AS udr_currency,
       COALESCE(oipo.amount, pw.amount)  AS effective_amount,
       oipo.order_item_price_override_id AS udr_price_override_ref
FROM   _chunk r                          -- the chunk: (udr_id, product_inventory_id, start_datetime)
JOIN   inventory.product_inventory pi ON pi.product_inventory_id = r.product_inventory_id
JOIN   ordering.product_order_item poi ON poi.product_order_item_id = pi.product_order_item_id
JOIN   price_windows pw ON pw.product_offering_id = poi.product_offering_id
       AND pw.eff_from <= r.start_datetime
       AND (r.start_datetime < pw.eff_to OR pw.eff_to IS NULL)          -- [start, end)
LEFT JOIN ordering.order_item_price_override oipo
       ON oipo.product_order_item_id = poi.product_order_item_id
       AND oipo.price_type = 'usage';
-- A record with no matching row → LOOKUP_MISS (MAJOR), not rated (D3).
```

`product_inventory_id` comes from `udr_subscriber_ref_id` (D3). The chunk is passed as a temp table / `VALUES` list, so the join is set-based.

### 3. Calculate, round, snapshot (`rp.py`)

For each resolved record: `effective_amount` → `Decimal`; `udr_usage_rate = effective_amount`; `udr_rated_price_raw = effective_amount` (18,6); `udr_rated_price = round(effective_amount, 2, udr_rounding_mode)` (D7/D8) — quantity ignored for `FLAT` (D5). Write the snapshot columns (D4), `udr_currency` (D9), `udr_rate_type='FLAT'`, `udr_rate_detail` (FLAT variant, D6), and the version stamps (D10).

### 4. `udr_rate_detail` schema use

Import the discriminated union from `validation/rating/udr-rate-detail.schema.ts`; validate the `FLAT` variant before write. Non-`FLAT` branches are present in the schema but their computation is a `# STUB:` naming the later phase.

### 5. Config introduced

Rounding mode → a single **flow variable** in v1 (rm00 §Configuration). Per-product rounding, if it ever arrives, becomes a `product_offering_price` attribute (a product-module change), not a rating one.

---

## Dependencies (packages to install)

**None new.** `psycopg` (the as-of query), `polars`/`pyarrow` (chunk I/O), and stdlib `decimal` are in the rm04 worker image. The `udr_rate_detail` Zod schema ships with rm01 (`validation/rating/`); rm08 uses it. No npm packages.

---

## Verification checklist

Live database + engine (real or local). Fixtures: a subscription pinned to an offering with a **dated price chain** and an **override**.

**Reproducibility (the headline — test #13)**

1. A record rated today, then **re-rated after both the catalog price row and the override have changed**, reproduces the **original amount** from its snapshotted inputs (`udr_usage_rate`, `udr_price_ref`, `udr_price_effective_date`, `udr_price_override_ref`) — never by re-resolving.

**As-of correctness (D1, D2)**

2. The price resolved is the one effective at `start_datetime` through the **pinned** `product_offering` version — a record on an old pin gets the old price even after the offering branches and a newer version activates.
3. A record whose `start_datetime` falls **exactly** on a price `start_date_time` resolves to the **new** price (`[start, end)`), matching `isEffectiveNow`.
4. When an `order_item_price_override` exists for `(order item, 'usage')`, the resolved amount is the **override**, not the catalog amount.
5. `udr_currency` equals the **resolved price row's** currency.

**Calculation and money (D5, D7, D8)**

6. `FLAT`: the charge equals the flat amount, with `USAGE_MBPS`/quantity **ignored**; `udr_rated_price_raw` (18,6) and `udr_rated_price` (18,2) are both stored and `udr_rounding_mode` recorded.
7. Rounding uses the per-record method (`HALF_UP`/`HALF_EVEN`/`TRUNCATE`); a sub-cent `amount` survives in `_raw` and rounds correctly in the rounded column — no `float` path.
8. Nothing in this unit calls `services/accounts/money.ts` for the multiplication; full-precision `Decimal` is used, rounded once.

**Snapshot, stamps, and misses (D3, D4, D10)**

9. All snapshot columns are populated on every rated row.
10. `rating_engine_version` equals the running image digest/tag; `rating_flow_revision` and `rated_datetime` are stamped.
11. A record whose subscriber/offering does not resolve raises **`LOOKUP_MISS`** at `MAJOR` and is not rated.

**Scope and hygiene (D5, D6, D11)**

12. Only `FLAT` is computed; non-`FLAT` rate types are enum-defined with a `# STUB:` calc; `udr_rate_detail` is validated against the typed union.
13. A chunk of 50,000 records resolves with **one** as-of query per chunk — no per-record fan-out.
14. No `console.*`, no `TODO` (only `# STUB:` for the non-`FLAT` calcs); `Decimal` throughout.
