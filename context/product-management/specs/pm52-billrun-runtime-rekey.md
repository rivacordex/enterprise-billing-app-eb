# pm52 — Bill-run runtime: recurring resolver re-key (cross-module, G-G)

**Unit:** pm52 (Part 4). **Boundary:** the recurring as-of resolution SQL in the bill-run flow, its contract comments, three bill-run suites and the shared aggregate helper. **A re-key and nothing else** — the capacity resolver, the `customer_bill_line` mapping, proration, rounding and the BAN aggregation grain (O7–O9) are not built here.
**Specs from:** `prodmgmt-architecture.md` §3.7 (reader inventory row 2), Inv. #36, #43 · `prodmgmt-code-standards.md` §6.21 · `prodmgmt-ai-workflow-rules.md` §3.1, §6.6, §6.13, §8.13 · `_updatemodule-product-pricing-components-plan.md` PC5, PC14, O7–O9 · `bm29-real-aggregation-recurring-price-resolver.md` (the resolver being re-keyed) · `pm00-build-plan.md` Part 4 › the cross-runtime decision (2026-09-21).
**Depends on:** **pm49**; **pm48** (the `_SAMPLE_` `flat_fee` whose amount this must reproduce) · **G-G authorization naming these files** · **bill-run-module owner sign-off**.

**Gate G-G — required before a line is written.** Obtain and record a written authorization naming exactly:

- `workflow-management/flows/bill-run-processor/local-dev/bill_run_processing.yml` (the `_bm29_resolved` CTE and the D33 checks only)
- `workflow-management/flows/bill-run-processor/bill_run_processing.template.yml` (contract comments only)
- `tests/db/billrun-phase3-journey.integration.test.ts`, `tests/db/billrun-recurring-aggregation.integration.test.ts`, `tests/db/billrun-verification-reconciliation.integration.test.ts`
- `tests/db/helpers/billrun-aggregate.ts`

plus the **bill-run-module owner's sign-off**, which must cover D4 below — the one place where the old contract has no exact successor.

**File-location correction to the build plan.** The pm46–pm56 table names `bill_run_processing.template.yml` as the reader. That file (217 lines) carries the **contract comments**; the executable SQL lives in `local-dev/bill_run_processing.yml` (979 lines), and the same query is mirrored in `tests/db/helpers/billrun-aggregate.ts`. All three carry the dropped columns and all three are in scope. Correct the build-plan row when this unit lands.

---

## Goal

Re-key the bill run's recurring price resolution from `price_type = 'recurring'` + `pricing_model = 'flat'` + the catalog `amount` onto `component_type = 'flat_fee'` with envelope `priceType = 'recurring'`, reading `flat_fee.params.amount` — so a bill run against the reshaped table produces byte-identical recurring charges.

---

## Design

### D1. What the resolver does today

`_bm29_resolved` builds an as-of window over `product.product_offering_price` filtered to `price_type = 'recurring'`, pruned to the account's active offerings, with `lead((start_date_time AT TIME ZONE 'UTC')::date) OVER (PARTITION BY product_offering_id ORDER BY start_date_time)`; picks the window containing `period_start`; `COALESCE`s an `ordering.order_item_price_override` (`price_type = 'recurring'`) over the catalog `amount`; maps `recurring_charge_period_length/_type` onto the account's `bill_cycle.frequency` as `period_factor`; and multiplies by `product_inventory.quantity`. A subscription is included only when its offering **intends** a recurring charge — a `recurring` catalog price exists, or an override does.

Three D33 HARD-fail arms follow: `RECURRING_PRICE_NOT_FOUND` (no as-of price, no prior snapshot), `RECURRING_PRICE_UNSUPPORTED` (a `tiered` as-of price with no flat override), `RECURRING_CURRENCY_MISMATCH` (a price in a currency other than the account's).

### D2. The re-key, line by line

| Today | After pm52 |
| --- | --- |
| `WHERE pop.price_type = 'recurring'` | `WHERE pop.component_type = 'flat_fee'` — the **lane**, not the envelope `priceType` (D3) |
| `pop.amount AS unit_price` | `(pop.price_component #>> '{params,amount}')::numeric AS unit_price` |
| `pop.pricing_model AS pricing_model` | `pop.price_component ->> 'priceType' AS envelope_price_type` (D3/D4) |
| `PARTITION BY pop.product_offering_id` | `PARTITION BY pop.product_offering_id, pop.component_type, pop.unit_of_measure` |
| `EXISTS (… pop2.price_type = 'recurring')` | `EXISTS (… pop2.component_type = 'flat_fee' AND pop2.price_component ->> 'priceType' = 'recurring')` |
| `oipo.price_type = 'recurring'` | **unchanged** — the ordering column is not dropped (PC13) |
| `recurring_charge_period_length/_type` → `period_factor` | **unchanged** — the charge-period columns are retained |

The `[eff_from, eff_to)` as-of selection, the account pruning, the override `COALESCE`, the snapshot read-not-re-resolve path (bm23/Inv. #20) and the `quantity` multiplication are all untouched.

### D3. Do **not** filter the window by the envelope `priceType` — the masking hazard survives the reshape

The current comment is explicit: the window is deliberately **not** filtered to `pricing_model = 'flat'`, so a current `tiered` price is *seen* and fails D33 rather than being masked behind an older flat row. That reasoning transfers, and it transfers to a real case:

**A `flat_fee` `oneTime` row and a `flat_fee` `recurring` row share one uniqueness lane.** Both are `component_type = 'flat_fee'` with `unit_of_measure` NULL, so pm46's `(offering, component_type, unit_of_measure, start_date_time)` key puts them in the same `lead()` partition. A `oneTime` `flat_fee` dated after a `recurring` one therefore **supersedes it in lane terms** — and a window filtered to `priceType = 'recurring'` would silently resolve the older, superseded recurring price and keep billing it. That is precisely the bug the old comment was written to prevent.

So: filter the window on `component_type = 'flat_fee'` only, carry the envelope `priceType` out of the window, and test it on the **resolved as-of row** (D4).

### D4. `RECURRING_PRICE_UNSUPPORTED` has no exact successor — this is the sign-off point

The arm exists for "the current as-of price is a shape this resolver cannot rate" — a `tiered` price. `tiered` is gone (PC8), so the arm's original trigger cannot occur. D3 produces its structural successor: the as-of `flat_fee` row is a **`oneTime`**, meaning the offering's current flat-fee price is not a recurring charge.

Three candidate behaviours, and this unit must not choose silently:

| Option | Behaviour | Consequence |
| --- | --- | --- |
| **A (recommended)** — keep the arm, re-key its trigger | As-of `flat_fee` resolves to `priceType = 'oneTime'` with no override → `RECURRING_PRICE_UNSUPPORTED`, HARD-fail for that account | Preserves the contract's shape and its "see it, do not mask it" intent; a genuinely ambiguous catalog state fails loudly rather than billing a superseded price |
| B — treat it as no recurring charge | The subscription yields no recurring line, like a usage-only offering | Simpler, but silently stops billing a customer whose catalog looks mis-authored — the exact outcome Inv. #28 and D33 exist to prevent |
| C — retire the arm | Remove the code and its message | A rejection code disappearing from the bill run's contract is a behaviour change owned by Bill Run, not by this update |

**Take A unless the bill-run owner directs otherwise, and record their decision in the sign-off.** The message text changes ("the offering's current flat fee is a one-time charge"), the code name does not. Whichever is chosen, note in the hand-off register that the lane-sharing of `recurring` and `oneTime` `flat_fee` rows is a consequence of G-F's key choice and may deserve a catalog-side rule later (a product-side guard against a `oneTime` superseding a `recurring`) — **that guard is not built here**.

`RECURRING_PRICE_NOT_FOUND` and `RECURRING_CURRENCY_MISMATCH` are unchanged in trigger, name and severity.

### D5. The capacity components are visible and must stay unbilled

A component-priced offering now carries `usage_rate`, `capacity_commitment` and `capacity_motivation` rows. The `component_type = 'flat_fee'` filter excludes all three, and the per-lane partition means none can truncate the `flat_fee` chain. **Nothing in this unit computes `Qbill = max(Q, committed)` or walks a step schedule** — the capacity resolver, the `customer_bill_line` mapping (motivation → `discount_*`, commitment top-up → `gross_amount`), proration (O8), rounding (O9) and the BAN grain (O7) are a later phase (Inv. #43).

**The capacity components remain unbilled, which is exactly what pm55's warnings tell the user.** A fixture asserts it: adding a `capacity_commitment` and a `capacity_motivation` to a billed offering changes no bill line, no amount and no count.

### D6. Money stays exact

Extract with `#>>` and cast to `numeric`, preserving the existing `::numeric(18,6)` for `unit_price` and `::numeric(18,2)` downstream. No `::float`, no JS number round-trip in the helper (§1.24, Inv. #32). The `_SAMPLE_` amount pm48 seeds is the amount this resolves — the two specs are pinned to the same constant.

### D7. Grants are table-level `SELECT` — no bootstrap role file is edited

`billrun_runtime`'s grant is table-level, so the new columns are readable with no bootstrap change (workflow §6.13). A unit editing `db/bootstrap/billrun-db-roles.sql` has misdiagnosed a reader break as a permission problem.

---

## Implementation

### I1. `local-dev/bill_run_processing.yml` — the `_bm29_resolved` CTE

Apply D2's changes; keep the CTE's structure, aliases, pruning subquery, `COALESCE` order and `period_factor` expression identical. Rename the carried column `pricing_model` → `envelope_price_type` and update every downstream reference in the same file.

### I2. The D33 checks in the same file

Re-key the three counters: `RECURRING_PRICE_NOT_FOUND` unchanged; `RECURRING_PRICE_UNSUPPORTED` per D4's chosen option, counting rows whose resolved `envelope_price_type <> 'recurring'` and that carry no override; `RECURRING_CURRENCY_MISMATCH` unchanged. Keep the RAISE structure, the per-account HARD-fail semantics and the transaction rollback exactly as they are.

### I3. `bill_run_processing.template.yml` — contract comments

Update the comment block to describe the component resolution: the `flat_fee` lane, the envelope `priceType` test on the resolved row, D3's masking reasoning in its new form, and D4's outcome. Keep every other contract line — snapshot reuse, Inv. #20/#21/#22/#28 references, the usage-only exclusion — as written.

### I4. `tests/db/helpers/billrun-aggregate.ts`

Mirror I1 and I2 exactly. This helper reproduces the resolver for the suites, so a divergence between it and the flow is a false green — diff the two queries deliberately as part of this unit.

### I5. Bill-run fixtures

Repair the three suites to seed `flat_fee` components at **identical amounts, periods, currencies and dates**:

- **billrun-recurring-aggregation** — the core re-key; assertions unchanged.
- **billrun-phase3-journey** — the end-to-end path; the produced bill must match the pre-reshape baseline.
- **billrun-verification-reconciliation** — checksum/reconciliation assertions unchanged.

Add three cases:

1. **D5** — an offering with `usage_rate` + both capacity components bills exactly as it did without them.
2. **D3** — a `oneTime` `flat_fee` dated after a `recurring` one is **seen**: the resolver does not silently bill the older recurring price (it takes D4's chosen outcome).
3. **Snapshot reuse** — a rerun after a backdated component insert still reproduces the original amounts (the lead() window is not re-walked; bm23/Inv. #20 unchanged).

### I6. Verification run

Run a full bill run against a database built from empty and seeded by pm48, and diff the produced `customer_bill` / `customer_bill_line` rows against a pre-reshape baseline captured before the branch. **Byte-identical recurring charges** is the success criterion and it is a diff, not a green suite.

### I7. Documentation

1. `prodmgmt-architecture.md` §3.7 and `prodmgmt-code-standards.md` §6.21 — mark the bill-run row re-keyed by pm52, and correct the file name to the `local-dev` flow plus the template's comments and the shared helper.
2. `pm00-build-plan.md` pm52 row — same file-name correction.
3. `pm00-build-plan.md` hand-off register — add the D4 decision and the `recurring`/`oneTime` lane-sharing consequence, with their owner.
4. **No `billmgmt-*` doc is edited** — cross-module doc edits need their own approval (workflow §7.9).

---

## Dependencies

**Packages to install: none.** Kestra flow YAML plus core PostgreSQL JSONB operators; no extension, no library.

**Commands used:** the bill-run flow's existing local run, `npm run test` (the three suites), `npm run db:migrate`, `npm run db:seed-sample`, `npx tsc --noEmit`, `npm run lint`.

**Prerequisite:** the recorded **G-G authorization** and the **bill-run-module owner's sign-off**, the latter explicitly covering D4.

---

## Verification checklist

Authorization

- [ ] G-G authorization and bill-run-owner sign-off recorded, naming exactly the seven files, with D4's option chosen in writing.
- [ ] `git diff --stat` touches no other billing, workflow or bootstrap file.

Behaviour (unchanged, proved by numbers)

- [ ] A bill run completes against the reshaped table and produces **byte-identical** recurring charges to the pre-reshape baseline — asserted by diff.
- [ ] `flat_fee.params.amount` is the source, cast via `numeric`, never a float; `period_factor` and `quantity` multiplication are unchanged.
- [ ] An order-item `recurring` override still wins over the catalog amount.
- [ ] A usage-only offering still yields no recurring line and does not fail.
- [ ] `RECURRING_PRICE_NOT_FOUND` and `RECURRING_CURRENCY_MISMATCH` fire for their unchanged triggers with unchanged severity.
- [ ] D4's chosen behaviour fires for a `oneTime` as-of `flat_fee`, and the older `recurring` price is **not** silently billed.
- [ ] Snapshot reuse on rerun still reproduces the original amounts.

Capacity stays unbilled

- [ ] Adding a `capacity_commitment` and a `capacity_motivation` to a billed offering changes no bill, no line, no amount.
- [ ] No `max(Q, committed)`, no step-schedule walk, no `discount_*` mapping, no proration and no new rounding exists in the diff.

Boundaries

- [ ] The flow YAML and the shared helper contain no reference to `pricing_model`, `amount` or `price_type` on the catalog table, and the two queries are identical to each other.
- [ ] `db/bootstrap/billrun-db-roles.sql` is byte-identical.
- [ ] The three bill-run suites are green with unchanged assertions; any assertion that had to change is raised, not absorbed.

**Definition of done:** a bill run reads its recurring price out of a JSON envelope, bills the same customers the same amounts as it did before the reshape, refuses to bill a superseded price when the catalog's current flat fee is a one-time charge, and leaves every capacity commitment and motivation exactly where Product stored them — stored, and not yet billed.
