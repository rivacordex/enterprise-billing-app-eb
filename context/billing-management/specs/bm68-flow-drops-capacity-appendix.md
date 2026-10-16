# bm68 — Capacity flow stops writing the appendix

**Unit:** bm68 (Invoice Template Phase 3) · **Status:** Planned · **Boundary:** the processing flow (`workflow-management/flows/bill-run-processor/`), its extracted-SQL tests, and the two grants that only the removed SQL used · **Depends on:** nothing new (bm49 already stopped reading the appendix)
**Authorizes:** D31, D46 · Inv #36 (amended), #38, #56 (the "never read `additional_info`" half) · code-standards Phase 3 Data rule 8 · guardrail item 66 · workflow rules §2.6, §4.4, §6.5

## Goal

Stop the `aggregation` step of `bill_run_processing` building and storing the bm45 per-polygon `appendix` inside each capacity line's `additional_info`, and drop its `CAPACITY_APPENDIX_OVER_LIMIT` guard. A capacity line then carries only `pricing`, `calc[]` and `summary[]`, and a live Kestra run still completes.

## Design

**Where the code is.** The executable SQL lives only in `workflow-management/flows/bill-run-processor/local-dev/bill_run_processing.yml` (1,866 lines), the flow bm38 promoted to production. `bill_run_processing.template.yml` (380 lines) holds the design comments only (~l.26, ~l.253–270). bm68 removes SQL from the local-dev flow and corrects the comments in both files.

**What is removed** (line numbers from `dev1` `1ab2bd1`):

| Block | Lines (local-dev) | Why it goes |
|---|---|---|
| `0g` `_bm45_card` temp table (the `productCardLookUp` card and its ACTIVE `ratecard_version`) | ~766–785 | only feeds the appendix |
| `0h` `_bm45_volume` temp table (per-`udr_key` volume/amount) | ~787–805 | only feeds the appendix |
| `0i` the `CAPACITY_APPENDIX_OVER_LIMIT` `DO` block | ~807–821 | the appendix's own bound; the invoice's bound is bm49's `INVOICE_USAGE_OVER_LIMIT` (D37) |
| CTE `capacity_appendix_mapped` | ~1015–1032 | appendix join to `product.ratecard_ran_usage_lkp` |
| CTE `capacity_appendix` | ~1034–1058 | builds the jsonb array |
| `COALESCE(ca.appendix, '[]'::jsonb) AS appendix` column and `LEFT JOIN capacity_appendix ca` in `capacity_totals` | ~1070, ~1075 | |
| `'appendix', ct.appendix` pair in the `additional_info` `jsonb_build_object` | ~1155–1160 | |

Nothing else in `aggregation` or `verification` reads `_bm45_*` or `appendix`. Verification binds the `calc` trace to the hashed money columns (Inv #35), not the appendix. `additional_info` stays unhashed. `charge_checksum` and every money column are untouched, so a rerun of the same data produces the same lines and `line_no` (Inv #16).

**Why nothing breaks.**
- The invoice stopped reading `additional_info.appendix` at bm49 and reads `udr_rated` instead (Inv #36 note).
- The appendix join also still rebuilds the old **lower-cased** canonical key (`lower(btrim(...))`, ~l.1029–1031). Since rating Phase H (rm24–rm29, implemented on `dev1`) stores `udr_key` raw, that join already matches nothing for new rows.

**Least privilege follows the removal.** `billrun_runtime` was granted SELECT on `product.ratecard_ran_usage_lkp` and `product.ratecard_version` in bm41 *for the appendix* (`db/bootstrap/billrun-db-roles.sql` ~l.333–343). A grep of both billrun flows finds no other reader. bm68 therefore revokes those two grants (Inv #23: grants are enumerated per need). `product.product_specifications` stays, because aggregation still reads the `udrType` characteristic. The bootstrap file is re-runnable, so the REVOKE is idempotent.

**Types.** `CapacityCalcTrace.appendix?` and `InvoiceUsageAppendixRow` (`types/billing.ts` ~l.333–370) lose their only writer. Delete them. If an older test fixture still constructs the field, the compiler reports it and the fixture is fixed in this unit.

**Kept as is.**
- The `_SAMPLE_` `capacity-appendix-multi-polygon` scenario and `db/seeds/sample/capacity-usage-card.ts`: the card is still what rating prices against, and the scenario remains a useful multi-polygon fixture for bm71.
- Migration `0044`'s comment, which is historical.

**Deliberately not done:** no TypeScript change in the app render path (bm49 already reads `udr_rated`). No change to the rated-row read or any other flow step. No new flow input.

**Visible result:** a live Kestra run on the `ci` seed reaches `COMPLETED`. A query over capacity lines shows `additional_info ? 'appendix'` is false for every row, while `pricing`, `calc` and `summary` are present.

## Implementation

### 1. Flow SQL (`local-dev/bill_run_processing.yml`)

1. Delete blocks `0g`, `0h` and `0i`.
2. Renumber nothing else; the step labels are comments.
3. Delete the two CTEs.
4. Remove the `appendix` column and the join from `capacity_totals`.
5. Remove the `'appendix', ct.appendix` pair.
6. Update the surrounding comments (~l.1150–1157) to say the trace is `pricing`/`calc`/`summary` only (bm68, D31).

Keep the YAML a repo commit; never edit it in the Kestra UI (workflow rules §6.5).

### 2. Design comments (`bill_run_processing.template.yml`)

- ~l.26: the `REAL (bm45)` line becomes "removed by bm68 (D31); the invoice reads `udr_rated` (bm49)".
- ~l.253: the trace shape becomes `{ v, productInventoryId, pricing, calc[], summary[] }`.
- ~l.261–270: the appendix and `CAPACITY_APPENDIX_OVER_LIMIT` paragraphs are replaced by one superseded note.

### 3. Grants

`db/bootstrap/billrun-db-roles.sql`:
- In the bm41 block (~l.333), remove the two ratecard tables from the `GRANT SELECT` list.
- Add an explicit `REVOKE SELECT ON TABLE "product"."ratecard_ran_usage_lkp", "product"."ratecard_version" FROM billrun_runtime;`, commented as bm68 / D31 / Inv #23, so already-bootstrapped databases lose them too.

### 4. Types

`types/billing.ts`: delete `appendix?: InvoiceUsageAppendixRow[]` from `CapacityCalcTrace` and the `InvoiceUsageAppendixRow` interface, and update the comment (~l.333) to drop "bm45 the invoice-appendix reader".

### 5. Tests

- `tests/db/billrun-capacity-appendix.integration.test.ts`: rewrite. It runs the extracted flow SQL (`tests/db/helpers/extract-flow-sql.ts`) on the multi-polygon fixture and asserts:
  - no capacity line's `additional_info` has an `appendix` key;
  - `pricing`, `calc` and `summary` are unchanged against the bm42 anchors;
  - 10,001 claimed polygon rows **no longer** fail the account. Only the invoice bound applies, so the account processes.

  Rename the file to `billrun-capacity-trace.integration.test.ts` and update any guardrail that lists it by name.
- `tests/db/helpers/billrun-capacity-pricing-fixtures.ts`: drop the appendix expectations.
- `tests/db/billrun-db-roles.integration.test.ts` case 17h (~l.1007–1053): `billrun_runtime` can SELECT `product_specifications`, and is **denied** SELECT on `ratecard_ran_usage_lkp` and `ratecard_version`. The write-denials stay.
- `tests/guardrails/ratecard-demo-seed-boundary.test.ts`: confirm it still passes (it mentions the appendix; adjust any appendix-specific assertion).
- **Guardrail item 66** (boundaries) lands here as a new `tests/guardrails/phase3-boundaries.test.ts`. It is a static-source test asserting:
  1. neither flow YAML contains `appendix` inside an `additional_info` build, nor the string `CAPACITY_APPENDIX_OVER_LIMIT`;
  2. `db/repositories/billing/invoice-render-input.ts` contains no `rating.` reference;
  3. no file under `services/billing/` or `actions/billing/` imports from `services/accounts/` or `actions/accounts/`;
  4. no billing file writes `billing_account` (an `update(billingAccount)` / raw `UPDATE billing.billing_account` search).

### 6. Live run

Run `scripts/billrun-live-kestra-smoke.ts` (`npm run billrun:live-kestra-smoke`) on the `ci` seed against a local Kestra with the edited flow redeployed. The run must reach `COMPLETED`.

## Dependencies

- **Packages:** none.
- **Units:** none new. It can land any time before bm73 (workflow rules §2.6).
- **Environment:** a local Kestra plus Postgres plus Azurite stack for the live run (README local setup), with the edited local-dev flow redeployed to the `billrun` namespace. The extracted-SQL suites need a disposable Postgres (the bm40 destructive-DB preflight applies).

## Verification checklist

- [ ] `grep -n "appendix\|_bm45\|CAPACITY_APPENDIX_OVER_LIMIT" workflow-management/flows/bill-run-processor/local-dev/bill_run_processing.yml` returns only explanatory comments, with no SQL.
- [ ] The extracted-SQL suites (aggregation, verification, trace, checksum) are green. The bm42 anchors 800/1000/2000/0 give identical money columns and `charge_checksum` before and after.
- [ ] Live-Kestra smoke on `ci` reaches `COMPLETED` (Inv #38: logic-green is not run-green).
- [ ] `billrun_runtime` grants, asserted over `information_schema`: SELECT on `product_specifications`, none on the two ratecard tables.
- [ ] Guardrail item 66 is green.
- [ ] `npm run typecheck` (the appendix types are gone with no dangling reference), `npm run lint`, and the unit and integration suites are green.
- [ ] No TypeScript change outside `types/billing.ts` and tests (workflow rules §4.4).
- [ ] Docs:
  - architecture Inv #36 note and the Phase 3 stack row marked "built (bm68)";
  - code-standards Data rule 8 and guardrail item 66 marked "built (bm68)";
  - the doc corrections below applied;
  - progress tracker updated.

## Open questions

None that need a decision. Doc corrections to apply with this unit:
1. **Where the edit goes.** Code-standards Data rule 8, workflow rules §2.6/§6.5 and bm00 say to remove the appendix "identically in both YAML copies". In fact only `local-dev/bill_run_processing.yml` has SQL; the `template.yml` copy is comments only. They should say: "remove the SQL from `local-dev/bill_run_processing.yml`; correct the design comments in `bill_run_processing.template.yml`".
2. **The grant revoke is new.** Code-standards Phase 3 and architecture said "no grant change" for this update. The two-table revoke follows Inv #23 (least privilege) and is the one grant change this update makes. Record it in architecture's auth deltas.
3. **TC54 still open.** The live smoke covers the `ci` profile only. The capacity-aware live harness (TC54) is still open (Part 3), so the capacity path is proven by the extracted-SQL suites plus the `ci` live run, as at bm46.
