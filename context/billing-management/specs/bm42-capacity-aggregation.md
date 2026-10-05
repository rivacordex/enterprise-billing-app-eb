# bm42 — Capacity aggregation: commitment floor, motivation discount, six guards, calc trace & seed

**Unit:** bm42 (Target Capacity Pricing update — _the core result_). **Boundary:** the `aggregation` step of `workflow-management/flows/bill-run-processor/local-dev/bill_run_processing.yml` (+ its `.template.yml` mirror) as `billrun_runtime`; one new flow input (`capacity_max_bands`); and the `_SAMPLE_` capacity seed in `db/seeds/sample/**`. **Inline SQL only — no DB function, no Python task, no app/UI change, no migration.** **Specs from:** `_updatemodule-billing-billrun-target-capacity-plan.md` §4 (aggregation), §4.2 (guards), §4.3–4.5 (the line + rounding), §6 (`additional_info`), §7 (where it runs), TC8–TC18/TC20/TC23–TC25/TC35–TC37/TC40/TC42/TC46/TC52; `billmgmt-update-overview.md` (Unit 42); `bm00-build-plan.md` Part 3 Unit 42. **Depends on:** bm41 (the `rated_amount`/`additional_info` columns + the `product.product_specifications`/ratecard grants) and bm40 (the repaired, redeployed flow on `udr_subscription_ref_id`), both shipped; PER_UNIT rating (TC45), treated shipped per the rating-config plan.

> **Verified against `enterprise-billing-app` (2026-10-04).**
>
> - `product.product_offering_price.component_type` CHECK already admits `'usage_rate' | 'flat_fee' | 'capacity_commitment' | 'capacity_motivation'` (`db/schema/product.ts:226`), with per-type CHECKs: `usage_rate` → `params.ratePerUnit` (numeric string) + `unit_of_measure NOT NULL` (`:233`); `capacity_commitment` → `params.committedQuantity` (number > 0) + `unit_of_measure NOT NULL` (`:241`); `capacity_motivation` → `params.steps` via `product.pricing_steps_ok(...)` + `unit_of_measure NOT NULL` (`:245`). The capacity model is already expressible; **no migration is needed** for the catalog.
> - `udrType` is a **`product.product_specifications` row** keyed by `name = 'udrType'` with the value in `default_value` (`db/seeds/sample/sample-5g-rating.ts:139-143`), **not** a `product_spec_characteristics` jsonb key (that column is a flat `{string:string}` record, often `{}`). Resolution is `SELECT default_value … WHERE name = 'udrType'`.
> - `rating.udr_rated` already carries the **renamed** `udr_subscription_ref_id` (`db/schema/rating/udr-rated.ts:59`) plus `udr_usage_rate` (nullable, `:69`), `udr_price_ref` (nullable, `:110`), `udr_usage_unit` (`:68`), `udr_usage_quantity` (`:63`), `udr_rated_price` (`:78`), `udr_type` (`:39`), `udr_currency` (`:107`). The deployed flow still joins the **dropped** `ur.udr_subscriber_ref_id` (`bill_run_processing.yml:570`) — bm40 fixes that; bm42 is authored against the post-bm40 name.
> - The `aggregation` psql body (`:373-702`) builds `_bm29_prior` / `_bm29_resolved` temp tables, deletes the trial bill (`billing.billrun_delete_trial_bill`), then inserts the header + all lines from a `usage_lines ∪ recurring_prior ∪ recurring_fresh` UNION with a single `row_number() OVER (ORDER BY grouping_key, source)` `line_no` (`:655-675`), and finally recomputes `customer_bill.subtotal = SUM(net_amount)` (`:683-700`). This is the exact structure bm42 extends; the `customer_bill_line` INSERT column list (`:655-660`) gains `rated_amount` + `additional_info` (bm41).
> - The `_SAMPLE_` bill-run seed (`db/seeds/sample/seed-billrun-sample.ts`) is profile-driven (`SeedProfile = "ci" | "volume"`, env `SAMPLE_SEED_PROFILE`, default `ci`) with a scenario table and a shared `buildSampleUdrRatedRow` factory (`udr-rated-sample.ts`). The factory hardcodes `udrRateType: "FLAT"`, `udrRateDetail: { rateType: "FLAT" }`, `udrUsageQuantity: "1.000000"`, and **leaves `udrUsageRate` NULL** — a capacity row left in that shape would trip `CAPACITY_RATE_MISMATCH` (the TC35 NULL-rate case), so the capacity profile needs the factory extended to a PER_UNIT shape (below).

## Goal

Price Target Capacity offerings inside the existing per-account whole-account-replace transaction of the `aggregation` step: identify each account's capacity offerings off their pinned offering version, apply the commitment floor and the N-band motivation discount as inline SQL CTEs (Model 1 — the number billed), enforce the six HARD account-level guards, write one capacity line per `(offering, unit)` (generated even at zero usage) carrying `rated_amount`, the discount, and the `additional_info` calc trace — and ship a `_SAMPLE_` capacity profile whose four anchor accounts (800 / 1000 / 2000 / 0 EA) bill to 100,000 / 100,000 / 150,000 / 100,000.

## Design

### D1 — one transaction, inline SQL, the bm28/bm29 pattern (TC8)

All capacity logic is inline SQL CTEs in the existing psql `aggregation` step, inside the same `BEGIN; … COMMIT;` whole-account-replace transaction as bm28/bm29 (Inv #16). No `billing.capacity_charge()` function (that moves pricing into a migration), no Python task (that splits the transaction). The pricing logic stays configurable within workflow management, deployed and versioned with the flow, and each run's `processing_flow_revision` records which revision priced a bill. The capacity CTEs sit **between** `_bm29_resolved`/its D33 guard and the `billrun_delete_trial_bill` → re-insert block, so the resolved capacity config is available to both the guards and the line build.

### D2 — resolve off the subscription's _pinned_ offering version (TC46, O-TC1 resolution)

Capacity components are resolved off `inventory.product_inventory.product_offering_id` — the **pinned, versioned** offering the subscription already points at, exactly as `_bm29_resolved` resolves the recurring `flat_fee` off `pi.product_offering_id` (`:441-444`). That id is the same version rating stamped `udr_usage_rate`/`udr_price_ref` from (rating-config plan A1), so the bill-run base rate equals rating's stamped rate **by construction** — this is what keeps a grandfathered account (pinned to an OBSOLETE version whose base rate differs from the current ACTIVE) off a spurious `CAPACITY_RATE_MISMATCH`. No `order_item` hop is needed (product_inventory already pins the version; the recurring resolver precedent proves it). The `lead(start_date_time)` as-of window (below) then only disambiguates rows _within_ the pinned version — a no-op under the one-card-per-version rule, kept for safety. **O-TC1 (snapshot on capacity lines):** capacity lines set `snapshot_* = NULL` (the USAGE-line precedent — snapshots are a recurring-derivation artifact); rerun stability comes from re-aggregating the same `BILL_DRAFT` rows plus the pinned-version resolution, and the resolved price ids are recorded in `additional_info.pricing`.

### D3 — the capacity line groups by `(offering, unit)`, generated from the subscription (TC14, TC15, O-TC2 resolution)

A capacity line groups by `(offering, unit_of_measure)` — the `boundTo` axis — not by `udr_type`; `grouping_key = '<offering_id>:CAPACITY:<unit>'` (e.g. `PRDOFR…:CAPACITY:EA`). It is driven by the **active capacity subscription** (like RECURRING), not by the presence of rated rows, so a zero-usage account still gets a line (`rated_amount` 0.00, `udr_count` 0, `quantity` 0, `topUp` = the full floor — the floor exists precisely for the no-usage case). The offering's usage in any _other_ unit stays an ordinary `(offering, udr_type)` USAGE line. **O-TC2 (the line's `quantity`):** `quantity` is the **actual metered usage `Q`** (`SUM(udr_usage_quantity)` over the capacity volume), not the floored billed quantity — the metered figure is what reconciles to `udr_count`/the rated rows; the billed/floored quantity is a derived construct and lives in `additional_info.calc`.

### D4 — Model 1 is the number billed; derive, round once (TC18, TC40)

Model 1 (`gross = rated_amount + topUp`, anchored on `Σ udr_rated_price`) is the billed calculation — the bill reconciles to the actual rated rows. Each monetary component (`topUp`, each band's charge and discount) is computed at full precision and **rounded once to 2 dp HALF_UP** (`round()`); `rated_amount` is already `Σ` of rating's rounded rows; `gross`/`net` are **derived** from the rounded parts and never rounded again, so the §5 verification identities hold with no tolerance. `discount_amount_raw` keeps the unrounded discount (scale 6). The `summary` strings render the **computed** `gross`/`net`, never a re-multiplied `target × baseRate` literal (fractional below-target usage can drift a cent — TC40). Model 2 (the independent cross-check) and the `CAPACITY_RATE_MATCHING` gate are **bm43**, not here.

### D5 — the six guards are HARD and account-level (TC9–TC13, TC16, TC35, TC37)

Each guard raises inside the transaction (the D33 pattern): the transaction rolls back, no bill for the account, the per-account `FAILED` signal settles it to `PROCESSING_FAILED`, every sibling keeps processing. bm42 ships `CAPACITY_RATE_MISMATCH` (**G2**) as an **unconditional HARD** guard — equivalent to the `CAPACITY_RATE_MATCHING` gate's default-ON behavior; bm43 introduces the gate and refactors G2 (+ adds the Model-2 aggregate) to downgrade to WARN when the gate is OFF. The `CAPACITY_MULTI_STEP_UNSUPPORTED` guard is parameterised by a new **`capacity_max_bands`** flow input (default 1), so the SQL is N-band and enabling multi-step later is a config change, never a pricing-SQL edit (TC52).

## Implementation

### 1. New flow input — `capacity_max_bands` (`bill_run_processing.yml` inputs + `.template.yml`)

Add to the flow `inputs` block (alongside `attempt`, `gl_event_at`, `force_fail`):

```yaml
- id: capacity_max_bands
  type: INT
  defaults: 1
  description: >
    Max motivation steps a capacity offering may carry before
    CAPACITY_MULTI_STEP_UNSUPPORTED fires. Production is single-band (1);
    the pricing SQL is N-band, so multi-step is enabled by raising this,
    never by editing SQL (TC52).
```

Thread it into the `aggregation` psql call as `-v capacity_max_bands="{{ inputs.capacity_max_bands }}"` (the existing `-v` list, `:368-372`). Mirror the input in `bill_run_processing.template.yml`.

### 2. Resolve the account's capacity offerings — `_bm42_capacity` temp table (after `_bm29_resolved`)

Create `CREATE TEMP TABLE _bm42_capacity ON COMMIT DROP AS …` immediately after the `_bm29_resolved` D33 guard block (`:543`), resolving — as-of the period, off the pinned `pi.product_offering_id` — for each ACTIVE capacity-priced subscription on `:'ban'`:

- **capacity-priced** = the pinned offering has a `capacity_commitment` **or** `capacity_motivation` `product_offering_price` row (as-of the `lead(start_date_time)` window, pruned to the account's offerings — the `_bm29_resolved` window pattern at `:431-448`);
- `base_rate` = the same-offering, **same `unit_of_measure`** `usage_rate` row's `price_component #>> '{params,ratePerUnit}'` (join on `unit_of_measure`, PC4 Option A — no price-id pointer, TC32); `base_price_ref` = that `usage_rate`'s `product_offering_price_id`;
- `target` = `capacity_commitment.params.committedQuantity` (NULL when commitment-only is absent — motivation-only, TC36);
- `steps` = `capacity_motivation.params.steps` jsonb array (NULL when motivation-only is absent — commitment-only, TC36);
- `unit` = the components' `unit_of_measure`; `currency` = the components' `currency`; `account_currency` = `billing.billing_account.currency`;
- `udr_type` = `product.product_specifications.default_value WHERE ref_product_offering_id = <offering> AND name = 'udrType'` (TC12);
- `offering_name` = `product.product_offering.name` (→ line `description`, TC20);
- `step_count` = `jsonb_array_length(steps)` (0 when NULL);
- `subscription_count` = COUNT of ACTIVE `product_inventory` rows for this `(account, offering family)` — for the `CAPACITY_MULTIPLE_SUBSCRIPTIONS` guard.

**Commitment and motivation are independent add-ons (TC36)** — the formula computes `topUp` (needs `target`) and the bands (need `steps`) independently; a missing component contributes zero to its term, so all three shapes (commitment-only / motivation-only / both) are first-class.

### 3. The six HARD guards — a `DO $$ … $$` block against `_bm42_capacity` (TC9–TC13, TC16, TC35, TC37)

Mirror the `_bm29_resolved` D33 `DO` block (`:522-543`): count the violating rows and `RAISE EXCEPTION` with a named code. All six, account-level:

| Code                                  | Raise when                                                                                                                                                                                                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CAPACITY_MULTIPLE_SUBSCRIPTIONS`     | any `_bm42_capacity` row has `subscription_count > 1`                                                                                                                                                                                                                                 |
| `CAPACITY_BASE_RATE_NOT_FOUND`        | a capacity offering (commitment or motivation present) has `base_rate IS NULL` (no same-`unit_of_measure` `usage_rate`)                                                                                                                                                               |
| `CAPACITY_UDR_TYPE_MISMATCH`          | any `BILL_DRAFT` row for a capacity subscription has `udr_type IS DISTINCT FROM` the offering's spec `udrType`                                                                                                                                                                        |
| `CAPACITY_RATE_MISMATCH` (**G2**)     | any `BILL_DRAFT` row in a capacity volume has `udr_usage_rate IS DISTINCT FROM base_rate` **or** `udr_price_ref IS DISTINCT FROM base_price_ref` — **`IS DISTINCT FROM`, not `<>`** (TC35: a NULL `udr_usage_rate`, i.e. a non-PER_UNIT row, must count as a mismatch, not slip past) |
| `CAPACITY_MULTI_STEP_UNSUPPORTED`     | any row has `step_count > :'capacity_max_bands'::int`                                                                                                                                                                                                                                 |
| `CAPACITY_CURRENCY_MISMATCH` (**G3**) | any row has `currency IS DISTINCT FROM account_currency` (parity with the delivered `RECURRING_CURRENCY_MISMATCH`, `billrun-aggregate.ts:129,138-140`)                                                                                                                                |

Each message names the offering and the offending value(s), so a mismatch is a config fix, not a hunt (the §5.4 diagnostic shape — bm43 extends G2's message to name both version sources when it wires the gate).

### 4. Capacity line build — a `capacity_lines` CTE in the INSERT UNION (§4.3–4.5)

Add a `capacity_lines` CTE to the `all_lines` UNION (`:628-632`), **driven by `_bm42_capacity`** (one row per `(offering, unit)`), LEFT JOINing the capacity volume so a zero-usage subscription still produces a line:

- **capacity volume** = `BILL_DRAFT` rows where `pi.product_offering_id` = the capacity offering **and** `ur.udr_usage_unit` = the capacity `unit` **and** `ur.udr_type` = the spec `udrType`; aggregate `Q = SUM(udr_usage_quantity)`, `rated_amount = SUM(udr_rated_price)`, `udr_count = COUNT(*)`;
- compute per §4.3 (N-band generic over `steps`, via `jsonb_array_elements`): `topUp = round(max(target - Q, 0) * base_rate, 2)` (0 when `target` NULL); per band `k`: `bandQty_k = quantity of Q in [aboveQuantity_k, aboveQuantity_{k+1})`, `bandCharge_k = round(bandQty_k * stepRate_k, 2)`, `bandDisc_k = round(bandQty_k * (base_rate - stepRate_k), 2)`; `discount = Σ bandDisc_k` (0 when `steps` NULL); `discount_raw = Σ` unrounded; `gross = rated_amount + topUp`; `net = gross - discount`;
- emit the CTE columns matching `all_lines` plus the two new ones — `source 'USAGE'`, `grouping_key '<offering>:CAPACITY:<unit>'`, `description = offering_name`, `quantity = Q`, `unit`, `gross_amount = gross`, `discount_amount = discount`, `net_amount = net`, `udr_count`, `currency`, `snapshot_* NULL` (D2/O-TC1), `rated_amount`, `additional_info` (§5 below).

**Exclude the capacity volume from `usage_lines`.** Today `usage_lines` (`:551-577`) groups **all** `BILL_DRAFT` by `(offering, udr_type)`. Add a `NOT EXISTS` / anti-join against `_bm42_capacity` so a row consumed by a capacity line (matching `offering` + `unit` + `udrType`) is **not** also emitted as an ordinary USAGE line — while a capacity offering's usage in a _different_ unit stays an ordinary line (§4.3). This is the one change to the existing USAGE CTE.

### 5. `rated_amount` + `additional_info` on every line (§4.4, §6)

Extend the `customer_bill_line` INSERT column list (`:655-660`) and the SELECT (`:661-675`) with `rated_amount` and `additional_info`, sourced per CTE:

- **`usage_lines`** (non-capacity USAGE): `rated_amount = gross` (= `SUM(udr_rated_price)`), `additional_info = NULL`.
- **`recurring_prior` / `recurring_fresh`**: `rated_amount = NULL` (not rated), `additional_info = NULL`.
- **`capacity_lines`**: `rated_amount = Σ udr_rated_price`; `additional_info` = the versioned calc trace (§6) built in the **same SQL expression** from the same values.

`line_no` stays the single `row_number() OVER (ORDER BY grouping_key, source)` across all sources (`:666`, Inv #21). The subtotal recompute (`:683-700`) is unchanged and now naturally includes the capacity discount (it sums `net_amount`).

### 6. `additional_info` calc trace — `jsonb_build_object` in SQL (§6, TC23–TC25)

Build `additional_info` as `{ v: 1, productInventoryId, pricing, calc[], summary[] }` (the §6 shape) inside the `capacity_lines` SELECT:

- `pricing` — resolved component rows: `usageRate {priceId, ratePerUnit}`, `commitment {priceId, committedQuantity}` (omit when absent), `motivation {priceId, steps[]}` (omit when absent);
- `calc` — ordered ops: `{op:'rated_sum', udrCount, quantity, amount}`, `{op:'commitment', target, outcome:'MET'|'SHORTFALL', shortfall?, topUp}`, one `{op:'motivation', band, from, to, quantity, baseRate, stepRate, charge, discount}` **per band** (`jsonb_agg` over the unnested steps), `{op:'total', gross, discount, net}` — named `calc`, not `steps`, so "steps" means only the motivation bands;
- `summary` — one display-ready string per op, numbers via `to_char` (thousands separators, 2 dp); the `net`/`gross` line renders the computed `total.gross`/`total.net` (D4/TC40), never a re-multiplied literal.

`additional_info` is **never hashed** (Inv #35 — bm44's checksum append binds only the money columns); the shape is enforced by the writer here and the bm41 read-model type, not a DB CHECK.

### 7. `_SAMPLE_` capacity seed — a `capacity` profile in `db/seeds/sample/**` (TC14/TC15 anchors)

Extend `seed-billrun-sample.ts` (not a new script — the merge rationale: a seed has no standalone visible result):

- **Profile.** Add `"capacity"` to `SeedProfile` / `SEED_PROFILES`; `resolveProfile` returns `CAPACITY_SCENARIOS`. Selected by `SAMPLE_SEED_PROFILE=capacity`.
- **Capacity offering.** Add `ensureSampleCapacityOffering()` (mirrors `ensureSampleOffering`'s DRAFT→price→ACTIVE idempotent path, `:547-679`) building a distinct `_SAMPLE_` **capacity** offering with, all `unit_of_measure = 'EA'`, `currency 'MYR'`, one version: a `usage_rate` (`params.ratePerUnit '100'`), a `capacity_commitment` (`params.committedQuantity 1000`), a `capacity_motivation` (`params.steps [{ aboveQuantity: 1000, ratePerUnit: '50' }]`); plus three `product_specifications` rows — `udrType='RAN_USAGE'`, `singleSubInstPerCust='true'`, `productCardLookUp=<card name>` (the `sample-5g-rating.ts:136-161` shape). Purge it in `purgeSampleGraph` by its offering name.
- **Scenarios.** `CAPACITY_SCENARIOS` = four accounts, one capacity subscription each, usage of **800 / 1000 / 2000 / 0 EA** of `RAN_USAGE`. Extend `ScenarioSpec` with a `capacityUsageEa?: number` field (the EA to seed as the capacity volume); zero EA seeds no rows (the TC15 zero-usage line).
- **PER_UNIT rows (the factory extension).** The capacity volume must be rated PER_UNIT so G2 passes: extend `SampleChargeSpec`/`buildSampleUdrRatedRow` with optional `usageQuantity`, `usageRate`, `rateType`, `usageUnit`, so a capacity row sets `udrUsageQuantity` (e.g. 1 EA/row), `udrUsageRate = '100'`, `udrRateType = 'PER_UNIT'`, `udrRateDetail = { rateType: 'PER_UNIT', … }`, `udrUsageUnit = 'EA'`, `udrPriceRef = <the usage_rate price id>` (**not** the recurring id), `udrRatedPrice = usageQuantity × 100`. Default branch keeps today's FLAT shape untouched. Seed each account's EA as N rows of 1 EA @ rated 100 (so `Σ udr_usage_quantity = EA`, `Σ udr_rated_price = EA × 100`).
- **Anchors** (the visible result): a bill run on the capacity profile writes four capacity lines — 800 → `gross 100,000` (`rated 80,000 + topUp 20,000`, discount 0), 1000 → 100,000 (floor met exactly, discount 0), 2000 → `gross 200,000 − discount 50,000 = net 150,000`, 0 → 100,000 (full floor, `rated 0`) — each with its `additional_info` trace; a mis-configured sibling (e.g. a non-PER_UNIT row) HARD-fails only itself.

## Dependencies

- **npm packages:** none. All logic is inline SQL (`psql` already in the task image) and TypeScript seed code using existing imports (`productOfferingPrice`, `productSpecifications`, `udrRated`, `persistablePricingComponentSchema`).
- **Prerequisite artifacts (must be shipped):** bm41 — `billing.customer_bill_line.rated_amount` + `additional_info`, and `billrun_runtime` `SELECT` on `product.product_specifications` + the ratecard tables (the `udrType` and offering-name reads here need `product_specifications`); bm40 — the redeployed flow on `udr_subscription_ref_id`; PER_UNIT rating (TC45) so `udr_usage_rate`/`udr_price_ref` are populated and `rated_amount = Q × baseRate`.
- **Downstream:** bm43 (verification + Model-2 + the `CAPACITY_RATE_MATCHING` gate — refactors G2), bm44 (checksum append + read-model surfacing), bm45 (invoice appendix — snapshots at this step). None may start until bm42 verifies.

## Verification checklist

- [ ] On the `capacity` seed, a triggered **live-Kestra** run reaches `PROCESSED` and writes the four anchor bills — 800 → 100,000; 1000 → 100,000; 2000 → net 150,000 (gross 200,000, discount 50,000); 0 → 100,000 — each capacity line carrying `rated_amount`, `discount_amount`, and an `additional_info` trace whose `calc.total.{gross,discount,net}` equal the money columns.
- [ ] The zero-usage account (TC15) produces a capacity line with `rated_amount 0.00`, `udr_count 0`, `quantity 0`, `gross_amount 100,000` (the full floor) — proving the line is subscription-driven, not row-driven.
- [ ] `gross_amount = rated_amount + topUp` and `net_amount = gross_amount − discount_amount` hold exactly (no ±0.01) on integer anchors; `discount_amount_raw` carries the unrounded discount; a fractional-usage fixture shows the accepted ≤1¢ TC40 drift and the `summary` renders the computed figure, not `target × baseRate`.
- [ ] Each guard fails the right account HARD and lets siblings bill: `CAPACITY_MULTIPLE_SUBSCRIPTIONS` (2 subs), `CAPACITY_BASE_RATE_NOT_FOUND` (modifier, no same-unit `usage_rate`), `CAPACITY_UDR_TYPE_MISMATCH` (synthetic off-type row), `CAPACITY_RATE_MISMATCH` (a row at rate 85, **and** a NULL-rate/non-PER_UNIT row — proving `IS DISTINCT FROM`, TC35), `CAPACITY_MULTI_STEP_UNSUPPORTED` (2 steps with `capacity_max_bands` 1; and that raising the input to 2 lets it through — TC52), `CAPACITY_CURRENCY_MISMATCH` (component currency ≠ account).
- [ ] Commitment-only (floor, discount 0) and motivation-only (`topUp 0`, `Qbill = Q`, discount applied) offerings each bill correctly (TC36).
- [ ] A capacity offering's usage in a **different** unit remains an ordinary `(offering, udr_type)` USAGE line; the capacity volume is **not** double-counted as a USAGE line (the `usage_lines` anti-join).
- [ ] Non-capacity lines are correct: USAGE `rated_amount = gross_amount`, `additional_info` NULL; RECURRING `rated_amount` NULL; a non-capacity `ci`-profile bill run produces byte-identical bills to before bm42 (no regression).
- [ ] Resolution is off the **pinned** `pi.product_offering_id`: a grandfathered account (pinned to an OBSOLETE version whose base rate ≠ the current ACTIVE) bills at the pinned rate and does **not** trip `CAPACITY_RATE_MISMATCH` (TC46).
- [ ] The DB suites run the **extracted** flow SQL (bm40 harness), not a hand-copied double; the new `capacity_max_bands` input is present on the deployed flow and its `.template.yml`; the capacity logic redeploys to `billrun`.
- [ ] No new migration; no app/UI change; `tsc`/eslint/the DB-free unit suite green; the DB-gated capacity suites green on a disposable Postgres.
- [ ] Docs: `bm00-build-plan.md` Part 3 Unit 42 unchanged; `billmgmt-architecture.md` capacity deltas/invariants and `billmgmt-code-standards.md` capacity guardrails name bm42 as the aggregation unit.
