# rm19 — Runtime rename + RP `PER_UNIT` computation — Spec

- **Unit:** rm19 of Phase G (`rm00-build-plan.md`)
- **Repo:** `workflow-management` · **Boundary:** `worker/workflow-engine/runtime/rp.py` (+ the rename in `rl.py`)
- **Authorizes from:** `_change-rating-configuration-plan.md` (A2, A3); `ratemgmt-architecture.md` Inv 22–24; `ratemgmt-code-standards.md` §0, §2.2 (Decimal, round-once); `ratemgmt-ai-workflow-rules.md` §0 rules 4, 7.
- **Depends on:** rm15 (renamed column + shape), rm17 (`perUnitRateDetailSchema`), rm18 (a scalar `usage_rate` price to resolve). Built on the **existing placeholder resolver** — the real resolver is rm20.

## Goal

In `rp.py`: perform the **wfm half of the column rename** (`udr_subscriber_ref_id` → `udr_subscription_ref_id`, atomic across `rp.py` and `rl.py`), then replace the hardcoded `FLAT` calculation with **`PER_UNIT`** — derive `udr_rate_type` from the resolved component, compute `ratePerUnit × usage_volume` in `Decimal` rounded once, emit the `perUnitRateDetail` JSON, source the unit from the product, and raise `CARD_DRIVEN_RATING_UNSUPPORTED` for a card-driven component.

## Design

- **The rename is done here, atomically, across `rp.py` + `rl.py`** (the two runtime modules that reference the column), before the PER_UNIT changes. Mechanical: only the column name (in the `RatedRecord`/output field and `rl.py`'s `COPY` list) changes; the value still holds a `product_inventory_id`. No half-rename (`§0` rule 7).
- **Reuse the existing resolution.** `_RESOLVE_SQL` (rp.py:~179) already resolves `component_type`, `unit_of_measure`, `currency`, `effective_amount` and the price ref through the pinned offering, filtered to `component_type = 'usage_rate'`, with the override applied — keep all of it. rm19 changes only what happens **after** resolution (the calc) and adds one projected column (`plaSpecId`).
- **`effective_amount` is the `ratePerUnit`** for a `usage_rate` component. FLAT stored it as the whole charge (quantity ignored); PER_UNIT multiplies it by the usage quantity. Same column (`udr_usage_rate` = `effective_amount`); the difference is the product with quantity.
- **`Decimal` throughout, round once** (the existing rounding map, rp.py:~75): `udr_rated_price_raw` at full precision `numeric(18,6)`, `udr_rated_price` rounded once to `numeric(18,2)` per `udr_rounding_mode`. Never `float`.
- **`udr_rate_type` is derived, not hardcoded.** The type comes from `component_type` + `plaSpecId`; the current literal `"FLAT"` (rp.py:~402) is replaced by the branch below.
- **The Python `per_unit_rate_detail()` is the exact mirror of `perUnitRateDetailSchema` (rm17)** — RL carries it as opaque text and never re-validates, so RP's emission is the only guard.

## Implementation

### 1. Column rename (wfm half — `rp.py` + `rl.py`)
Rename `udr_subscriber_ref_id` → `udr_subscription_ref_id` everywhere in both modules: the `RatedRecord` field, the record builder that sets it, and `rl.py`'s `COPY` column list. Mechanical, no behavior change.

### 2. Project `plaSpecId` into resolution (`_RESOLVE_SQL`, rp.py:~179)
Add to the `price_windows` SELECT so the resolved row carries it:
```sql
popp.price_component->>'plaSpecId'     AS pla_spec_id,
popp.price_component->>'rateCardLookUp' AS rate_card_lookup,
```
(These live in the `price_component` jsonb; the scalar sample has both `null`.)

### 3. Derive `udr_rate_type` (replace the hardcoded `"FLAT"`)
```
component_type == 'usage_rate' and pla_spec_id is None   → "PER_UNIT"
component_type == 'usage_rate' and pla_spec_id == 'PLA_USAGE_RATE'
                                                          → raise CARD_DRIVEN_RATING_UNSUPPORTED
component_type == 'flat_fee'                              → "FLAT"   (existing path unchanged)
```
`CARD_DRIVEN_RATING_UNSUPPORTED` is a loud, diagnosable RP failure (event code from rm18), never a silent/partial result.

### 4. `PER_UNIT` computation
- `rate = Decimal(effective_amount)` (the `ratePerUnit`); `qty = Decimal(usage_quantity)` (the passthrough exact string).
- `udr_rated_price_raw = (rate * qty)` quantized to `numeric(18,6)`.
- `udr_rated_price = round(udr_rated_price_raw − udr_discount_amount_raw, udr_rounding_mode)` at `numeric(18,2)`; `udr_discount_amount_raw = 0` for this product.
- `udr_usage_rate = effective_amount`; `udr_usage_quantity` = the input volume (unchanged). The `FLAT` branch (quantity ignored) stays exactly as-is for `flat_fee`.

### 5. `per_unit_rate_detail()` (mirror of rm17)
```python
def per_unit_rate_detail(rate: str, qty: str, amount_raw: str) -> dict[str, str]:
    detail = {"rateType": "PER_UNIT", "ratePerUnit": rate, "quantity": qty, "amountRaw": amount_raw}
    _validate_per_unit_rate_detail(detail)   # rateType == 'PER_UNIT'; exactly these 4 keys; strings
    return detail
```
Keep `flat_rate_detail()` (rp.py:137) for the `FLAT` branch; select by derived `udr_rate_type`.

### 6. `udr_usage_unit` from the product
Set `udr_usage_unit` = the resolved `unit_of_measure` (already returned by `_RESOLVE_SQL`), not the feed. *(The removal of the `_FEED_UNIT_TO_CATALOG` join input is rm20's resolver rewrite; rm19 only changes what is stored.)*

### 7. Tests (`tests/rating/rm08-rp-price-resolution-snapshot.integration.test.ts` refresh — **regression R1**)
- A record priced at `ratePerUnit = 100`, `usage_volume = 20` → `udr_rate_type = "PER_UNIT"`, `udr_rated_price_raw = "2000.000000"`, `udr_rated_price = "2000.00"`, `udr_rate_detail = {rateType:"PER_UNIT", ratePerUnit:"100.000000", quantity:"20", amountRaw:"2000.000000"}`, `udr_usage_unit = "Mbps"`.
- Rounding modes still round once (HALF_UP/HALF_EVEN/TRUNCATE) from the raw.
- A card-driven (`plaSpecId='PLA_USAGE_RATE'`) component → `CARD_DRIVEN_RATING_UNSUPPORTED`, no rated row.
- The `flat_fee` FLAT path is unchanged. The FLAT assertions are **refreshed** to PER_UNIT, never deleted.

## Dependencies

**None.** `Decimal` is Python stdlib; already baked into the worker image. No new package.

## Verification checklist

- [ ] `grep -rn "udr_subscriber_ref_id" workflow-management/` returns **zero** hits (rp.py + rl.py swept); the `COPY` list uses `udr_subscription_ref_id`.
- [ ] `PER_UNIT`: `100 × 20` → raw `2000.000000`, rated `2000.00`; a fractional rate (e.g. `0.0035 × 3`) rounds once per `udr_rounding_mode` and never touches `float`.
- [ ] `udr_rate_type` is **derived** — `usage_rate`+`plaSpecId=null` → `PER_UNIT`; `usage_rate`+`PLA_USAGE_RATE` → `CARD_DRIVEN_RATING_UNSUPPORTED`; `flat_fee` → `FLAT`.
- [ ] `udr_rate_detail` for PER_UNIT validates against `perUnitRateDetailSchema` (field-for-field; a Python-vs-Zod parity check).
- [ ] `udr_usage_unit` is the product's `unit_of_measure` (`Mbps`), read from the resolved component, not the feed.
- [ ] rm08's suite is green with PER_UNIT assertions (R1); the FLAT path still passes.
- [ ] Diff is `workflow-management/runtime` only (rp.py, rl.py); no app-repo change.
