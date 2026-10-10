# bm42a — Flow fixes: aggregation SQL, trace money format, USAGE tamper check

**Unit:** bm42a (a follow-up to delivered bm42/bm43, named on the `pm56a`/`pm56b` pattern; Target Capacity Pricing update, Part 1). **Status: DELIVERED 2026-10-10** (open questions 1 to 3 answered: `steps` verbatim, static guard included, doc comment only; see the progress tracker). Not committed at the time of writing.

**Boundary:** `workflow-management/flows/bill-run-processor/local-dev/bill_run_processing.yml` **only** (the `aggregation` and `verification` steps), the DB suites that exercise it, and docs. **No migration, no grant change, no app code, no `template` file change** (`bill_run_processing.template.yml` is a non-deployable skeleton and carries none of this SQL).

**Specs from:** Inv #3 (`customer_bill_line` is the charge record), #17 (compute lives in the flow), #29 (Model 1 billed, Model 2 only checks), #32/#33 (capacity guards, zero-usage floor), #35 (`additional_info` is never hashed), #38 (flow SQL is tested from the extracted YAML; logic-green is not run-green); code-standards TS rule 3 (money is `string` end to end); workflow rules §2.5 (a change to delivered behaviour is its own unit) and §6.2 (the deployed flow is only ever changed by a repo commit).

**Depends on:** bm42, bm43, bm45 (delivered), bm40 harness (fixed in `2a95617`: its variable binder now skips comments, strings and dollar-quoted bodies, which is what let these defects surface).

**Gates:** none open. Owner decisions recorded 2026-10-10: money in the trace is **text** (Defect 2, option A); unit name **bm42a**; **spec first for review**.

> **Evidence this spec rests on (2026-10-10, throwaway Postgres).** Before the harness fix, 38 DB tests failed on a harness error and hid everything below. After it, 34 failed. With D1 below applied **temporarily and reverted**, the eight affected suites went to **37 of 40 passing**; the remaining three are exactly D2 (2 tests) and D3 (1 test). The flow file was restored byte-for-byte (`git diff` empty). Nothing in this spec has been applied to the repository.

## Goal

Make the deployed `bill_run_processing` flow run to completion again and restore two guarantees it was meant to give: (1) the `aggregation` statement is valid SQL, so a bill can be assembled at all; (2) the capacity calculation trace carries money in the form the module's contract says; (3) `verification` once again catches an altered `gross_amount`/`net_amount` on an ordinary USAGE line. All eight billing-run DB suites pass, including the full-journey suite.

## The three defects (plain language)

1. **The statement can't run.** One step numbers the rows of a list *inside* the call that folds that list into one JSON value. Postgres forbids a window function inside an aggregate. Because the capacity step sits in the single `aggregation` statement, **aggregation fails for every account**, capacity or not.
2. **Amounts are written as numbers, not text.** The type, the tests and the module rule say money is a string. When a JavaScript program reads a JSON number it drops the trailing `.00` (`40000.00` becomes `40000`). The database stores the scale correctly; the mismatch is in the contract. *Nothing in the app reads these values today* (the invoice moved to reading rows directly in bm49; the trace is database-only), so the impact is consistency, not wrong invoices.
3. **A safety check got weaker.** bm43 switched the ordinary USAGE replay from `gross_amount` to `rated_amount` (correct for capacity lines, which add a top-up). Its spec calls that "behaviour-preserving". It is not: if `gross_amount`/`net_amount` change while `rated_amount` stays put, verification now passes. A mis-aggregated or altered line can then reach approval and posting.

## Design

### D1 — Compute the band number before aggregating (Defect 1)

`capacity_band_json` (line ~1002) builds each band entry with `'band', row_number() OVER (PARTITION BY offering_id, unit ORDER BY above_quantity)` **inside** `jsonb_agg(… ORDER BY above_quantity)`.

Change:

- In `capacity_band_charges` (line ~988), add a column to the `SELECT` list: `row_number() OVER (PARTITION BY offering_id, unit ORDER BY above_quantity) AS band_no`. A window function is legal in a `SELECT` list.
- In `capacity_band_json`, replace the inline call with `'band', band_no`.

The partition, the ordering and the output (`1, 2, …` per `(offering, unit)`) are identical. `capacity_band_rollup` sums `band_discount` from the same CTE and is unaffected. This is the same edit that was applied temporarily to produce the 37/40 result above.

### D2 — Money and decimal quantities in `additional_info` are JSON strings (Defect 2, option A)

**Contract (new, binding):** every monetary amount, rate and decimal quantity inside `customer_bill_line.additional_info` is emitted as the JSON **string** of its numeric text at a **canonical scale** (`value::numeric(p,s)::text`): money `numeric(18,2)` (`"100000.00"`), quantities `numeric(20,6)` and rates `numeric(18,6)` (`"400.000000"`). The explicit cast makes the form deterministic: a catalog value such as a commitment of `1000` would otherwise serialise as `"1000"`. No value loses precision: quantities and rates are already limited to 6 dp and money to 2 dp upstream. Integers that are not money stay JSON numbers. A catalog value copied **verbatim** from the product envelope stays exactly as the catalog has it.

| Where | Field | Becomes |
| --- | --- | --- |
| `pricing.usageRate` | `ratePerUnit` | text |
| `pricing.commitment` | `committedQuantity` | text |
| `pricing.motivation` | `steps` | **unchanged** (verbatim catalog copy) |
| `calc` `rated_sum` | `quantity`, `amount` | text (`udrCount` stays integer) |
| `calc` `commitment` | `target`, `shortfall`, `topUp` | text |
| `calc` `motivation` (per band) | `from`, `to`, `quantity`, `baseRate`, `stepRate`, `charge`, `discount` | text (`band` stays integer) |
| `calc` `total` | `gross`, `discount`, `net` | text |
| `appendix[]` rows | `volume`, `amount` | text (`polygon`, `state`, `district` are already text) |
| top level | `v` | stays integer |
| `summary[]` | (already text) | unchanged |

`jsonb_strip_nulls` still removes a NULL `shortfall` (MET case) and the last band's NULL `to`, because `NULL::text` is NULL.

**Safe by construction for readers.** Every reader of the trace in the flow uses `->>` plus a numeric cast (`(elem->>'topUp')::numeric(18,2)`, `(total_calc->>'gross')::numeric(18,2)`, the band-discount sum), which returns the same value from a JSON number or a JSON string. Model-2 re-resolves pricing from the catalog and never reads the trace back. `charge_checksum` does not hash `additional_info` (Inv #35), so no checksum changes. There is **no app reader** of these values (verified: `bill-line-table.tsx` documents `additionalInfo` as database-only; the repository only passes it through as `CapacityCalcTrace`).

**Existing traces.** None exist in production (the flow could not run, Defect 1). Any trace in a developer database that was written in the old number form is read correctly by the `->>` casts, so **no backfill or migration** is needed.

**Type.** `CapacityCalcTrace.calc`/`pricing` stay `unknown`-typed. Only the doc comment in `types/billing.ts` is updated to state the string contract. `InvoiceUsageAppendixRow` already declares `volume`/`amount` as `string` and now matches what is written.

### D3 — Restore the plain-USAGE tamper check (Defect 3)

In the `verification` step's ordinary-USAGE replay (`mismatched` CTE, line ~1539), keep the bm43 comparison of `SUM(udr_rated_price)` to `rated_amount` and `udr_count`, and **add** two comparisons for lines with `additional_info IS NULL` (non-capacity):

- `gross_amount IS DISTINCT FROM rated_amount`  (bm43's own spec: `rated_amount = gross_amount` for non-capacity USAGE lines)
- `net_amount IS DISTINCT FROM (gross_amount - discount_amount)`  (the identity capacity lines already get at line ~1639)

Any hit keeps raising the existing `RECONCILIATION_MISMATCH (HARD)`, with the message extended to name the claimed gross/net so an operator sees which column moved. Capacity lines (`additional_info IS NOT NULL`) are untouched: they keep their own internal-identity and Model-2 checks. `RECURRING` lines are still excluded (`rated_amount` is NULL for them; correctness is the price snapshot). The checksum tuple is not touched (Inv #35).

### D4 — Rollout

No schema change. The flow is deployed by `deploy_workflow_flows` (the `bill-run-processor/local-dev` folder) and by the local stand-up bootstrap; a redeploy is the whole rollout. Nothing is in flight in production (the flow never completed an aggregation). In a developer database, re-run any run that failed at aggregation; a rerun is already a whole-account replace.

## Implementation

1. `bill_run_processing.yml`: D1 (two edits), D2 (the trace and appendix `jsonb_build_object` calls, `::text` on the fields in the table), D3 (two added predicates plus message). One commit, flow only.
2. `types/billing.ts`: doc comment on `CapacityCalcTrace` (string contract). No type change.
3. Tests (below). Existing tests that already encode the right behaviour are **not** weakened or edited to fit.
4. Docs: known-issues §21 (close 21c2/21c3/21c4), progress tracker, architecture/code-standards note for the new contract (below), `bm00-build-plan.md` unit entry.

## Tests

The three tests that fail after D1 alone already assert the intended behaviour and become green with D2/D3 without edits:

| Existing test | Currently | Fixed by |
| --- | --- | --- |
| `billrun-capacity-aggregation` "the four anchors" (`String(total.gross)` is `"100000.00"`) | fails on number form | D2 |
| `billrun-capacity-appendix` "snapshots a per-polygon appendix…" (`amount: "40000.00"`, `volume: "400.000000"`) | fails on number form | D2 |
| `billrun-verification-reconciliation` "a mis-aggregated USAGE line is caught HARD" | verification returns `DONE` | D3 |
| the other 31 tests (aggregation, recurring, volume, capacity, verification, journey) | fail on the invalid SQL | D1 |

New tests:

| Test | Covers |
| --- | --- |
| `billrun-verification-reconciliation` (add) | altering **only `net_amount`** on a plain USAGE line (gross intact) is `RECONCILIATION_MISMATCH`; altering only `discount_amount` (breaking `net = gross − discount`) is caught; a clean line still passes DONE; a capacity line is unaffected; the message names the account |
| `billrun-capacity-aggregation` (add) | **trace contract test**: walk `additional_info`; every value is a string matching `^\d+\.\d{2}$` (money) or `^\d+\.\d{6}$` (quantity/rate) except the integer keys `v`, `udrCount`, `band` and the verbatim `steps`; last band has no `to`; MET case has no `shortfall`; appendix rows carry string `volume`/`amount` |
| `tests/guardrails/…` DB-free static guard (add, recommended) | scans the extracted `aggregation` heredoc and fails if a window function (`OVER (`) appears **inside** the parentheses of an aggregate call (`jsonb_agg`, `sum`, `string_agg`, …). Catches Defect 1 without a database; Postgres rejects it anyway, but this fails in the fast unit run |
| full unit + integration projects | the eight billing-run suites green; no new failure elsewhere; `1102 passed / 48 failed` baseline improves by the 34 |

**Not covered here (must be run, per Inv #38):** a live-Kestra execution of the real flow on the `ci` and `capacity` seeds. The DB suites run the extracted SQL; a live run is still the only proof the deployed flow completes. The harness for the capacity profile does not exist yet (`billrun-live-kestra-smoke.ts` is `ci`-only; tracker, bm46 TC54). bm42a does not build it, and does not claim it.

## Dependencies

- **npm:** none. **Migration / grants:** none.
- **Prerequisite units:** bm42, bm43, bm45; harness fix `2a95617`.
- **Downstream:** unblocks known-issues §21 closure (21c2/21c3/21c4) and a trustworthy capacity journey (TC54). Separate and **not** part of this unit: the product-module flat-fee lane gap (pm46 / known-issues §21e).

## Verification checklist

- [ ] `aggregation` executes: the 31 suites that failed with `aggregate function calls cannot contain window function calls` pass.
- [ ] Every money/decimal field in the trace table above is a JSON string with the right scale; integers stay numbers; the trace contract test passes.
- [ ] Altering `gross_amount`, `net_amount` or `discount_amount` alone on a plain USAGE line is `RECONCILIATION_MISMATCH (HARD)`; capacity lines and RECURRING lines behave as before.
- [ ] Verification, Model-2 and the identity checks still pass on the new trace form (they read through `->>` casts).
- [ ] `charge_checksum` is byte-identical for the same lines before and after (Inv #35).
- [ ] The flow diff touches only the two steps; `bill_run_processing.template.yml` is unchanged; no migration or grant file changes.
- [ ] `npm run typecheck`, `npm run lint`, `npm test` and the integration project pass apart from the known product-module failures (`ordering-read`, pm46 lane gap).
- [ ] Docs, same change set: known-issues §21 (21c2/21c3/21c4 closed), tracker, the string-money trace contract recorded in the architecture and code-standards Target Capacity deltas, `bm00-build-plan.md` lists bm42a.

## Open questions for review

1. **`pricing.motivation.steps`** is copied from the catalog envelope (`aboveQuantity` is a JSON number, `ratePerUnit` a string). This spec **leaves it verbatim** rather than rewriting catalog data. Agree?
2. **Static guard test.** Include the DB-free "window function inside an aggregate" guard (recommended), or rely on the DB suites alone?
3. **Type tightening.** Leave `CapacityCalcTrace.calc` as `unknown[]` with a doc comment (this spec), or add a typed `CapacityCalcOp` union now? The latter is more code for no current reader.

## Not in this unit

- The product flat-fee lane gap (pm46): cross-domain, gated, its own unit.
- A live-Kestra capacity journey (TC54) and the capacity smoke harness.
- Any change to the harness (already fixed), to the `template` flow file, to the checksum tuple, or to the invoice render path.
