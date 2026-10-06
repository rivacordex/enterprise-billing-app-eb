# bm43 — Capacity verification: rated_amount replay, Model-2 cross-derivation & the CAPACITY_RATE_MATCHING gate

**Unit:** bm43 (Target Capacity Pricing update). **Boundary:** the `verification` step of `bill_run_processing.yml` (+ `.template.yml`) as `billrun_runtime` — **plus** the minimal gate-consultation edit to bm42's G2 in the `aggregation` step (see D4), and one new flow input (`capacity_rate_matching`). **Inline SQL only — no DB function, no Python, no app/UI change, no migration.** **Specs from:** `_updatemodule-billing-billrun-target-capacity-plan.md` §5.1–5.2 (new assertions), §5.4 (the gate), §7 (verification row), TC19/TC21/TC50/TC51/TC55; `billmgmt-update-overview.md` (Unit 43); `bm00-build-plan.md` Part 3 Unit 43; Inv #29/#30. **Depends on:** bm42 (the capacity line, `rated_amount`, `additional_info`, G2), bm41 (the columns), bm40 (the repaired flow).

> **Verified against `enterprise-billing-app` (2026-10-04).** The `verification` step (`bill_run_processing.yml:762-864`) is `SELECT`-only (idempotent replay, retried; `:766-769`). Its `DO` block replays each **USAGE** `charge` line: a `replay` CTE re-sums `udr_rated` by `grouping_key = pi.product_offering_id || ':' || ur.udr_type` (`:806-818`), LEFT-JOINs it to the stored line, and HARD-fails `RECONCILIATION_MISMATCH` when `replay_sum IS DISTINCT FROM l.gross_amount` **or** `replay_count IS DISTINCT FROM l.udr_count` (`:819-852`), with a per-account `RAISE NOTICE` trace (`:846`) and a SOFT non-positive-total advisory (`:854-862`). It sets `billrun.ban/run/attempt` GUCs via `set_config` (`:785-787`) and reads them with `current_setting` (the pattern Model-2 reuses). It still joins the **dropped** `ur.udr_subscriber_ref_id` (`:812`) — bm40 renames it; bm43 is authored against the post-bm40 `udr_subscription_ref_id`. No `capacity_rate_matching` / `CAPACITY_RATE_MATCHING` exists in the flow yet; the only capacity flow input is `capacity_max_bands` (added by bm42).

## Goal

Make `verification` correct for capacity bills — replay every USAGE line against **`rated_amount`** (not `gross_amount`, which a top-up inflates), replay capacity lines by `(offering, unit, udrType)`, assert the capacity internal identities, and add the independent **Model-2** cross-derivation (`max(Q, target) × baseRate`) — then put both the per-row G2 (bm42) and the Model-2 disagreement under one `CAPACITY_RATE_MATCHING` flow gate: default **ON** → loud HARD-fail naming both rates and both version sources; **OFF** (deliberate, logged) → downgrade to WARN and bill Model 1 anyway, recording the relaxed state on the run.

## Design

### D1 — replay against `rated_amount`, not `gross_amount` (§5.1, §5.2)

bm30 asserts `SUM(udr_rated_price) = gross_amount`. A commitment top-up makes `gross_amount = rated_amount + topUp > rated_amount`, so **every** under-target capacity account would fail that check today. The fix: the replay compares `SUM(udr_rated_price)` to **`l.rated_amount`** (bm41's column, populated by bm42 on every USAGE line including capacity), and `COUNT(*)` to `l.udr_count`. For a non-capacity USAGE line `rated_amount = gross_amount` (bm42), so this is behaviour-preserving for them; for a capacity line it isolates the rated-row reconciliation from the floor/discount, which are checked separately (D2).

### D2 — capacity lines: replay by `(offering, unit, udrType)` + internal identities (§5.2)

A capacity line's `grouping_key` is `<offering>:CAPACITY:<unit>`, which the bm30 `offering:udr_type` replay key does not match (it would LEFT-JOIN to nothing → a false mismatch). So capacity lines (discriminated by **`additional_info IS NOT NULL`** — set only on capacity lines this phase) get a **separate** replay keyed on the capacity volume: the `BILL_DRAFT` rows for the subscription with `udr_usage_unit = <unit>` **and** `udr_type = <spec udrType>`, asserting `SUM(udr_rated_price) = rated_amount` and `COUNT(*) = udr_count`. Then the stored-line **internal identities** (HARD, `RECONCILIATION_MISMATCH`): `gross_amount = rated_amount + (additional_info->'calc'… topUp)`; `net_amount = gross_amount − discount_amount`; `calc.total.{gross,discount,net}` equal the money columns; `Σ` the `calc` motivation-band discounts `= discount_amount`. These bind `additional_info` to the hashed money columns (why the trace itself is not hashed — Inv #35).

### D3 — Model-2 is an independent cross-derivation, re-resolved (§5.2, §5.4, TC50)

Model 1 (billed, aggregation) is `rated_amount + topUp`. Model 2 is a **deliberately different** formula computed in verification: `expected_gross = max(Q, target) × baseRate` and `expected_discount = Σ overageₖ × (baseRate − stepRateₖ)`, over the capacity volume `Q`. Its inputs (`target`, `steps`, `baseRate`) are **re-resolved from the catalog** off the subscription's pinned offering version — the same resolution bm42's `_bm42_capacity` performs, re-run here as a read CTE — **not** read back from the stored `additional_info` (reading Model 1's own stored values back would not be an independent check). Two different formulas, independently resolved, agreeing is the real integrity proof (TC21, revised by TC50). **Caveat (T2/TC55):** on _fractional multi-row_ usage Model 2's exact reconcile can diverge a cent from Model 1 by the accepted TC40 rounding; noted and accepted (fractional drift is not expected for this product), with raw-scale reconciliation the durable fix and the gate the operational relief if it ever trips.

### D4 — one gate governs G2 (aggregation) and Model-2 (verification) (§5.4, Inv #29/#30)

`CAPACITY_RATE_MATCHING` (a flow input, default **ON/true**) governs what happens when **either** the per-row G2 (bm42, aggregation) **or** the Model-2 aggregate (verification) disagrees with Model 1:

- **ON (default):** HARD-fail `CAPACITY_RATE_MISMATCH`, loud, naming **both** figures and **both** version sources — "rating priced at RM X (price_ref P, offering version V1); bill-run resolved RM Y (price_ref Q, version V2)" — so a mismatch is a 5-minute config fix.
- **OFF (deliberate, logged — never silent):** downgrade to a `RAISE NOTICE` WARN; the account **proceeds, billing Model 1's number**; the relaxed state is recorded on the run.

Because G2 lives in the aggregation transaction, an OFF gate must stop G2 rolling the account back there — otherwise verification (and "bill Model 1 anyway") is never reached. So bm43 **necessarily** threads the gate into bm42's G2: a minimal edit making G2's `RAISE EXCEPTION` conditional on the gate (ON → raise as bm42 shipped; OFF → `RAISE NOTICE` and continue). This is the only cross-step edit in bm43; everything else is the verification step. bm42 shipping G2 as unconditional-HARD was the correct default-ON behaviour on its own — bm43 adds the override, it does not change the default.

### D5 — recording the relaxed state without a migration

"Recorded on the run" (§5.4) is satisfied without schema change: `CAPACITY_RATE_MATCHING` is a flow **input**, so its value is captured in the Kestra execution record alongside `processing_flow_revision`; additionally, when the gate is OFF **and** a mismatch was downgraded, both the aggregation and verification steps `RAISE NOTICE 'CAPACITY_RATE_MATCHING=OFF … billed Model 1 despite mismatch (rating RM X vs bill-run RM Y)'`, so the per-account run log carries the fact. A durable per-bill `capacity_rate_matching` column is a **future option** (it needs a migration — out of this unit's boundary); the execution input + the NOTICE are the record this phase.

## Implementation

### 1. New flow input — `capacity_rate_matching` (`bill_run_processing.yml` inputs + `.template.yml`)

```yaml
- id: capacity_rate_matching
  type: BOOLEAN
  defaults: true
  description: >
    ON (default): a capacity rate disagreement — per-row G2 (aggregation) or
    the Model-2 cross-derivation (verification) — HARD-fails the account,
    naming both rates and both version sources. OFF (deliberate, logged):
    downgrade to a WARN and bill Model 1 anyway; the relaxed state is logged
    per account (Inv #29/#30, TC51).
```

Thread it into **both** psql calls' `-v` lists as `-v capacity_rate_matching="{{ inputs.capacity_rate_matching }}"` (aggregation `:368-372`, verification `:781-784`). Mirror in `.template.yml`.

### 2. Aggregation G2 made gate-aware (the one cross-step edit — bm42's `DO` block)

In the bm42 guard `DO` block, replace G2's unconditional `RAISE EXCEPTION 'CAPACITY_RATE_MISMATCH …'` with:

```sql
IF v_rate_mismatch > 0 THEN
  IF current_setting('…capacity_rate_matching…')::boolean THEN
    RAISE EXCEPTION 'CAPACITY_RATE_MISMATCH (HARD): account % — rating stamped rate/price_ref differs from the resolved usage_rate on % row(s): %', …;
  ELSE
    RAISE NOTICE 'CAPACITY_RATE_MATCHING=OFF: account % — % row(s) mismatch the resolved rate; billing Model 1 anyway (%).', …;
  END IF;
END IF;
```

(The gate value is passed via `-v` and read with `:'capacity_rate_matching'::boolean`, matching how the step already consumes `-v` vars.) All five other bm42 guards stay unconditionally HARD — the gate governs **rate matching only**, never the structural guards (multiple-subscriptions, base-rate-not-found, udr-type-mismatch, multi-step, currency).

### 3. Verification — replay every USAGE line against `rated_amount` (the bm30 `replay`/`mismatched` CTEs)

In the existing `DO` block (`:806-852`): change the `mismatched` comparison from `… IS DISTINCT FROM l.gross_amount` to `… IS DISTINCT FROM l.rated_amount`, and have the `replay` CTE exclude capacity lines' grouping (it groups by `offering:udr_type`; capacity volumes are replayed separately in §4). Keep the `COUNT`/`udr_count` check and the `IS DISTINCT FROM` (NULL-safe) semantics; keep the per-account `RAISE NOTICE` and the SOFT non-positive-total advisory unchanged. Diagnostic text updates `gross` → `rated` wording.

### 4. Verification — capacity replay + internal identities + Model-2 (new CTEs)

Add, for lines where `additional_info IS NOT NULL`:

1. **Capacity replay.** A CTE re-resolving each capacity line's `(offering, unit, udrType)` (the bm42 resolution, as a read) and re-summing the capacity volume (`udr_usage_unit = unit AND udr_type = udrType`): assert `SUM(udr_rated_price) IS DISTINCT FROM l.rated_amount` **or** `COUNT(*) IS DISTINCT FROM l.udr_count` → HARD `RECONCILIATION_MISMATCH`.
2. **Internal identities.** Assert `l.gross_amount = l.rated_amount + topUp`, `l.net_amount = l.gross_amount − l.discount_amount`, `(additional_info->'calc'→total)` fields = the columns, and `Σ` band discounts from `calc` = `l.discount_amount` → HARD `RECONCILIATION_MISMATCH` (these are internal, never gated).
3. **Model-2 cross-derivation.** From the re-resolved `target`/`steps`/`baseRate` and the volume `Q`, compute `expected_gross = max(Q, target) × baseRate` and `expected_discount = Σ overageₖ × (baseRate − stepRateₖ)`; compare to `l.gross_amount`/`l.discount_amount`. A disagreement is governed by the **gate** (§5.4): ON → HARD `CAPACITY_RATE_MISMATCH` naming both figures/version sources; OFF → `RAISE NOTICE` WARN and pass. Honour the TC55 fractional-rounding caveat in the comparison tolerance note (exact for integer usage; the accepted ≤1¢ drift documented).

### 5. Diagnostics (§5.4)

The gate-ON HARD message (both in aggregation G2 and verification Model-2) names: the account, the offering, rating's stamped rate + `udr_price_ref`, and the bill-run resolved `ratePerUnit` + `usage_rate` price-id (the two version sources) — so operations can tell a rate-card value, a negotiated override, or a mid-period change apart at a glance. The gate-OFF WARN names the same figures and states "billed Model 1 anyway."

## Dependencies

- **npm packages:** none (inline SQL; `psql` already present).
- **Prerequisite artifacts:** bm42 (the capacity line + `rated_amount` + `additional_info` + G2 whose `DO` block this edits), bm41 (`rated_amount`/`additional_info` columns), bm40 (the flow on `udr_subscription_ref_id`). PER_UNIT rating (TC45) so `udr_usage_rate`/`udr_price_ref` are populated for G2/Model-2.
- **Downstream:** bm44 (checksum append — appends `rated_amount` to the hash, consumes verified lines), bm46 (ship gate drives the full journey). bm45 (appendix) is independent of bm43.

## Verification checklist

- [ ] On the bm42 `capacity` seed, a **live-Kestra** run reaches `PROCESSED`: verification replays all four anchor accounts against `rated_amount` (not `gross_amount`) and the under-target accounts (800, 0 EA) now pass where the bm30 check would have HARD-failed them.
- [ ] A capacity line's internal identities hold: `gross = rated_amount + topUp`, `net = gross − discount`, `calc.total` = the money columns, `Σ` band discounts = `discount_amount`; corrupting any one (e.g. tampering `gross_amount`) HARD-fails `RECONCILIATION_MISMATCH`.
- [ ] Model-2 reconciles on all four anchors (integer usage → exact); it is computed from **re-resolved** `target`/`steps`/`baseRate` + the volume, not read back from `additional_info` (a test that corrupts `additional_info.pricing` alone does **not** make Model-2 pass spuriously).
- [ ] Gate **ON** (default): a seeded rate disagreement (a row rated at 85, or a base-rate change on the current ACTIVE version with a pinned subscription) HARD-fails `CAPACITY_RATE_MISMATCH` in the right step, with a message naming both rates and both version sources; a sibling bills.
- [ ] Gate **OFF**: the same disagreement downgrades to a WARN in **both** the aggregation G2 path and the verification Model-2 path, the account bills **Model 1's** number, and the run log carries a `CAPACITY_RATE_MATCHING=OFF` NOTICE per affected account; the flag value is visible on the Kestra execution record.
- [ ] The five structural guards remain unconditionally HARD regardless of the gate (only rate-matching is gated).
- [ ] Non-capacity USAGE lines still reconcile (`rated_amount = gross_amount`); a non-capacity `ci` bill run verifies byte-identically to before bm43 (the `rated_amount` swap is behaviour-preserving for them).
- [ ] The DB suites run the **extracted** flow SQL (bm40 harness); `capacity_rate_matching` is present on the deployed flow and `.template.yml`; the flow redeploys to `billrun`.
- [ ] No migration; `tsc`/eslint/DB-free unit suite green; the DB-gated capacity verification suites green on a disposable Postgres (gate ON and OFF both covered).
- [ ] Docs: `bm00-build-plan.md` Part 3 Unit 43 unchanged; `billmgmt-architecture.md` invariants #29/#30 and the capacity verification delta name bm43; the one cross-step G2 edit is noted in the bm42 cross-reference.
