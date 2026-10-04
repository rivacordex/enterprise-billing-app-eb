# rm20 — RP: consume resolved subscription + drop the feed-unit price join — Spec

- **Unit:** rm20 of Phase G (`rm00-build-plan.md`)
- **Repo:** `workflow-management` · **Boundary:** `worker/workflow-engine/runtime/rp.py`
- **Authorizes from:** `_change-rating-configuration-plan.md` (OV-5; A2 unit-from-product); decision **A** (resolution is PRP's, rm21).
- **Depends on:** rm18 (seed), rm19 (PER_UNIT compute + `udr_usage_unit` from the product).

## Goal

Rewrite RP's price resolution to consume the `product_inventory_id` PRP resolves and carries (rm21) and to **drop the feed-unit dependency** — remove `pw.unit_of_measure = r.usage_unit`, `_FEED_UNIT_TO_CATALOG` / `_map_feed_unit`, and the `usage_unit` chunk column — selecting the offering's single `usage_rate` lane directly, since the unit is now product-sourced (rm19).

## Design

- **RP does not resolve the subscriber (decision A).** It trusts the chunk's `product_inventory_id` (PRP writes the real one in rm21). This unit's change is valid whether that value is still the placeholder or already real — it only touches the *price* path.
- **The feed unit is gone.** rm19 sources `udr_usage_unit` from the resolved component's `unit_of_measure`, so the price lane no longer needs the feed unit to disambiguate. The offering carries **one scalar `usage_rate` lane** (the single-price-card rule), so the lane is selected by `(product_offering_id, component_type='usage_rate')` as-of `start_datetime` — no unit predicate.
- **`LOOKUP_MISS` semantics preserved.** After the change, a **unit mismatch is no longer a `LOOKUP_MISS` cause** (there is no unit input to skew). The other no-row causes are unchanged — an unresolved `product_inventory` / `product_order_item` join, no `usage_rate` lane on the offering, or a `start_datetime` before that lane's first effective price.
- **The `unit_of_measure` projection stays.** rm19 reads it for `udr_usage_unit`; only the JOIN *predicate* on it is removed.

## Implementation

### 1. `_RESOLVE_SQL` (rp.py:~169)
- Remove `usage_unit` from the `_chunk` `unnest(... )` column list (rp.py:176) — the chunk no longer carries it.
- Remove `AND pw.unit_of_measure = r.usage_unit` from the price join (rp.py:230).
- Remove `popp.unit_of_measure` from the `price_windows` `PARTITION BY` (rp.py:208–209) — the lane is now `(product_offering_id, component_type)` only (one `usage_rate` lane). Keep `popp.unit_of_measure` in the `SELECT` (rm19 reads it).

### 2. Remove the feed-unit mapping
Delete `_FEED_UNIT_TO_CATALOG` (rp.py:263) and `_map_feed_unit` (rp.py:~269) — dead once the feed unit is not matched.

### 3. Chunk plumbing (`resolve_chunk` / `subscriber_series` / `process_chunks`)
Drop the `usage_units` parameter (rp.py:280) and every call site that assembles/passes it. PRP no longer needs to emit the feed unit into the chunk for lane matching.

### 4. Keep the rest
The `product_inventory` → `order_item` → pinned-offering → `product_offering_price` join chain (rp.py:221–231), the override application, the snapshot columns, and the `plaSpecId` projection (rm19) are unchanged.

### 5. Tests (`tests/rating/rm08-*` refresh)
- A record resolves its price via the single `usage_rate` lane with **no** feed unit in the chunk; `udr_usage_unit` is still the product's `Mbps`.
- An offering with no `usage_rate` lane → `LOOKUP_MISS`; a unit mismatch is no longer a resolution failure mode (there is no unit input).

## Dependencies

**None.** Python-only change to `rp.py`.

## Verification checklist

- [ ] `grep -nE "_FEED_UNIT_TO_CATALOG|_map_feed_unit|_to_catalog_unit|\busage_unit" rp.py` returns **zero** hits. (The `\b` word boundary matches the removed feed-side `usage_unit` / `usage_units` tokens but **not** the retained `udr_usage_unit` output field — rm19 sources it from the product's `unit_of_measure`, spec §4.)
- [ ] Price resolves on `(product_offering_id, usage_rate, as-of start_datetime)` — a single lane — without any unit predicate; the seeded Sample-5G record prices correctly.
- [ ] `udr_usage_unit` is still the product's `unit_of_measure` (rm19), unaffected by removing the join predicate.
- [ ] A unit mismatch is no longer a `LOOKUP_MISS` cause; the remaining no-row causes (inventory/order-item join, missing `usage_rate` lane, pre-first-price `start_datetime`) are unchanged; the rm08 suite is green.
- [ ] Diff is `rp.py` only.
