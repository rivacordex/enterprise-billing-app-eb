# rm27 — RP: carry `udr_resource` — Spec

- **Unit:** rm27 of Phase H (`rm00-build-plan.md`)
- **Repo:** `enterprise-billing-app` (wfm surface) · **Boundary:** `workflow-management/worker/workflow-engine/runtime/rp.py` and a new `tests/rating/rm27-rp-carry-udr-resource.integration.test.ts`.
- **Authorizes from:** `_updatemodule-rating-udr-key-resource-plan.md` R5, R6 and §3 (RP); `ratemgmt-architecture.md` Inv 28; `ratemgmt-code-standards.md` §0.1; `ratemgmt-ai-workflow-rules.md` §0.1 rule 12 (RP is its own unit).
- **Depends on:** rm26 (PRP emits `udr_resource` in the chunk). No other dependency.

## Goal

Make RP pass the chunk's `udr_resource` column through to its rated Parquet unchanged, so RL (rm28) can write it, without touching any pricing or resolution logic.

## Design

- **Pass-through, not logic.** RP already carries PRP's `state` and `district` from the incoming chunk to the rated chunk without interpreting them: `_GEO_COLUMNS` (`rp.py:121`) is read per chunk (`:746-750`), collected per rated row (`:782-783`) and appended to the rated frame (`:795-798`). `udr_resource` rides the same mechanism; the change is adding its name to the tuple.
- **Rows that are not rated carry nothing.** The collection loop appends only for records that resolve (`:758-783`); an unresolvable record is dropped together with its `udr_resource`, which keeps the column aligned with the rated rows. No change.
- **Carried only when PRP emitted it** (`if name in frame.columns`, `:749`), exactly like the geo columns. This keeps RL's missing-column guard (rm28) meaningful: a `RAN_USAGE` chunk that lost the column upstream must still fail loud at RL.
- **Do not rename `_GEO_COLUMNS`.** The name is now slightly narrow, but renaming is a cosmetic change outside this unit. Update the comment at `:119-120` to say the tuple lists the ratecard-cell columns PRP stamps (`state`, `district`, `udr_resource`).
- **No change to pricing, rounding, `RatedRecord`, `rate_record` or `_rated_frame`.** `udr_key` already passes through (`:617`, `:740`, `:775`) and arrives raw because PRP builds it raw (rm26); RP must not touch it.
- **Tests use the maintained harness, not the rm08 suite.** `tests/helpers/rating-ran-harness.ts` runs the real PRP → RP → RL modules with the production 7-column profile, the way rm13 and rm23 do. The rm08 suite is not used: its `runPrp` omits the now-required `--subscription-product-name` and uses the pre-rm21 feed profile (the progress tracker lists it as unrun). Repairing it is outside this unit; leave it untouched.

## Implementation

### 1. `rp.py`
- `:121` → `_GEO_COLUMNS: tuple[str, ...] = ("state", "district", "udr_resource")`.
- Update the comments at `:119-120` and `:743-745` as in Design.
- Nothing else in `rp.py` changes.

### 2. Tests (`tests/rating/rm27-rp-carry-udr-resource.integration.test.ts`, new)
Copy the structure of `rm23-udr-geo-frozen.integration.test.ts`: `describe.skipIf(!databaseUrl || !pythonRuntimeReady())`, migrate, seed the event catalog, provision roles, `seedSample5gRatingGraph`, `createRatingPipeline`. Cases:
1. **Carried.** `runPrp` → `runRp` on a clean three-row file; read both Parquet files with `python3 -c` polars (as rm07's `readParquetColumn` does): the rated `udr_resource` column equals the PRP chunk's per row and in order, and equals `Selangor|DIST-n|2026-01-01` for the three Sample-5G cells.
2. **Blank labels.** A graph whose card has `state ""` and `district "   "` yields `||2026-01-01` in the rated chunk.
3. **Absent stays absent.** After PRP, rewrite its chunk with a small polars call that drops `udr_resource` and nothing else, then run RP: the rated chunk has no `udr_resource` column, so RL's guard (rm28) can fire. This helper is the only new test utility.
4. **Key untouched.** The rated `udr_key` equals the PRP chunk's `udr_key` byte for byte, with the upper-case polygon `PCU-042_04` intact.
5. **Pricing unchanged.** With the column present, `udr_rate_type = PER_UNIT`, `udr_rated_price_raw = ratePerUnit × usage_volume`, `udr_rate_detail` unchanged (regression R1 intact).

## Dependencies

None.

## Verification checklist

- [ ] `_GEO_COLUMNS` contains `udr_resource`; the diff to `rp.py` is that tuple plus two comments.
- [ ] The rated chunk's `udr_resource` equals PRP's value row for row, including `||<date>`.
- [ ] A chunk without `udr_resource` produces a rated chunk without it.
- [ ] `udr_key` passes through RP byte for byte.
- [ ] PER_UNIT amounts, `udr_rate_detail` and the snapshot columns are identical to before.
- [ ] The new rm27 suite is green against a live database with `python3` and the worker runtime; the rm08 suite is untouched.
- [ ] The diff touches only `rp.py` and the new test: no `prp.py`, no `rl.py`, no migration, no flow YAML, no billing file.
