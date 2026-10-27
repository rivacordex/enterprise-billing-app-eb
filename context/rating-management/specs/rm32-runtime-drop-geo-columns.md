# rm32 — PRP, RP and RL stop writing `state`/`district` — Spec

- **Unit:** rm32 of Phase J (`rm00-build-plan.md`)
- **Repo:** `enterprise-billing-app` (wfm surface) · **Boundary:** `workflow-management/worker/workflow-engine/runtime/{prp,rp,rl}.py`, the comment at `workflow-management/flows/rating-engine/rating-engine-ran-usage.yaml:135`, and the retargeted suites `tests/rating/rm07-prp-claim-validate-reject`, `rm08-rp-price-resolution-snapshot`, `rm09-rl-guarded-transactional-load`, `rm13-e2e-journey`, `rm27-rp-carry-udr-resource`.
- **Authorizes from:** `_change-rating-drop-udr-rated-geo-columns-plan.md` D1, D2, D3, D8 and §3; `ratemgmt-architecture.md` Inv 26 (reversal note), Inv 28; `ratemgmt-code-standards.md` §0.1 data rule 3 (reversal note); `ratemgmt-ai-workflow-rules.md` §0.1 rule 10 (reversal note) and the **rm32 waiver** recorded under §4.
- **Depends on:** rm31 (the reversal notes are in; a reviewer can cite D-numbers). **One unit for all three components**, under the recorded §4.3 waiver: ordered commits RL → RP → PRP → tests, each separately reviewable.

## Goal

Make rating write the matched rate-card cell's geo **once**, in `udr_resource`, by removing the duplicate `state`/`district` stamp from the chunk, the rated Parquet and the COPY — with no change to how `udr_resource` is built, carried, validated or written. After this unit the runtime never references the two columns, while the schema still has them (nullable) until rm33.

## Design

- **Subtractive only.** No new field, column, event code, flow variable or guard. Every line removed is one that handled `state`/`district` as row data; every line kept is one that handles them as card data.
- **PRP keeps the labels as inputs, drops them as outputs (plan D3).** `RatecardCell.state`/`.district` (`prp.py:432-433`) stay: `build_udr_resource` (`:500-505`) and `invalid_label_cells` (`:508-518`) read them, and `_RATECARD_SQL` (`:440`) keeps selecting `l.state, l.district`. What goes is the per-row copy: `ParsedRow.state`/`.district` (`:714-715`), the enrichment stamps (`:1171-1172`) and the two Parquet series in `_chunk_frame` (`:881-882`). `udr_resource` (`:716`, `:1172`, `:885`) is untouched.
- **RP is one tuple literal.** `_GEO_COLUMNS` (`rp.py:124`) becomes `("udr_resource",)`. The pass-through loop (`:836`) is generic and carries whatever the tuple names, "only when PRP emitted them", so RL's missing-column guard still catches a lost `udr_resource`.
- **RL drops the geo allowlist, keeps the resource guard.** `"state"`, `"district"` leave `COPY_COLUMNS` (`rl.py:147-148`); `_GEO_OPTIONAL_COLUMNS` (`:160`), the loop at `:291-292` and `_geo_value` (`:298-309`) are deleted. `_GEO_REQUIRED_UDR_TYPE` (`:161`) stays — `_resource_value` (`:312-335`) uses it and is unchanged. `db.copy_insert(..., COPY_COLUMNS, rows)` and `build_chunk_rows` both derive from the tuple, so the COPY and the row builder cannot disagree.
- **No "tolerate the columns" code.** `build_chunk_rows` builds `cols` from `COPY_COLUMNS` members present in the frame (`rl.py:245`), so an extra Parquet column is ignored by construction; and because PRP changes in the same unit, no deployed image ever produces a chunk that carries them. The plan's earlier five-unit ordering logic is moot under D8.
- **Schema lag is safe.** Until rm33 the two columns exist and are nullable; rows loaded after rm32 simply carry `NULL` there. No grant touches them.
- **Comments are part of the diff.** Every comment that says the geo is "carried to `udr_rated.state/district`" is reworded in the same commit as the code it describes: `prp.py:426`, `:522`, `:713`, `:879-880`, `:1169-1170`; `rp.py:121-123`; `rl.py:145-146` and the block at `:152-159`; `rating-engine-ran-usage.yaml:135` ("stamps that cell's state/district/udr_resource" → `udr_resource`). The YAML change is a comment, not a task change: `rating_flow_revision` does not move.
- **Failure shape is the existing one.** The only guard in play is `_resource_value`; a `RAN_USAGE` chunk without `udr_resource` still raises `KeyError`, the process exits non-zero, nothing is archived, the batch is left at `PROCESSING` for rm11. No new event code.
- **Out of scope:** `0045`, `udr-rated.ts`, seeds, `rm01`, `grants`, `rm23`, the e2e raw INSERT (all rm33); `udr_key`; anything about `udr_resource`'s value, delimiter or date; billing code.

## Implementation

Ordered commits inside the one PR (waiver): **1 → 2 → 3 → 4**. The tree is green after each.

### 1. `rl.py` (commit 1)
- Remove `"state"`, `"district"` from `COPY_COLUMNS` (`:147-148`); the tuple ends `…, "rated_datetime", "udr_resource"`. Reword the comment at `:145-146`: `udr_resource` is appended last (rm28); the bm48 pair is gone (Phase J).
- Delete `_GEO_OPTIONAL_COLUMNS` (`:160`); keep `_GEO_REQUIRED_UDR_TYPE`.
- Delete the `for name in _GEO_OPTIONAL_COLUMNS:` loop (`:291-292`) and `_geo_value` (`:298-309`). `row["udr_resource"] = _resource_value(...)` (`:293`) stays.
- Rewrite the comment block at `:152-159` to describe `udr_resource` only (required and non-empty for `RAN_USAGE`, `NULL` otherwise, raised on a non-RAN value).
- Update the `_resource_value` docstring (`:313-317`): "absent column → `KeyError`, like the geo columns" → "like any other missing COPY column".

### 2. `rp.py` (commit 2)
- `_GEO_COLUMNS: tuple[str, ...] = ("udr_resource",)` (`:124`); comment `:121-123` → "rm27 / Phase J — the ratecard-cell column PRP stamps on a matched RAN record (`udr_resource`); RP passes it through untouched."
- Nothing else; do not rename `_GEO_COLUMNS` (rm27's decision stands).

### 3. `prp.py` (commit 3)
- `ParsedRow`: delete `state: str | None = None` and `district: str | None = None` (`:714-715`) and the bm48 comment above them (`:713`); keep `udr_resource` (`:716-717`).
- Enrichment (`:1169-1172`): delete the bm48 comment and the two stamps; keep `row.udr_resource = ratecard_cell.udr_resource`.
- `_chunk_frame` (`:879-882`): delete the bm48 comment and the two `pl.Series`; keep the `udr_resource` series (`:883-885`).
- Reword the docstrings that mention stamping `state`/`district` onto the record: `RatecardCell` (`:426-428` — the labels are inputs to `udr_resource`, not stamped), `_geo_label` (`:522-524`).
- `RatecardCell`, `_RATECARD_SQL`, `extract_ratecard`, `build_udr_resource`, `invalid_label_cells`, `_geo_label`: **no change**.
- `rating-engine-ran-usage.yaml:135`: comment only.

### 4. Tests (commit 4)
**`rm09-rl-guarded-transactional-load`** (DB-free block, `BUILD_ROW_SCRIPT` `:300-320`):
- Delete the `with_geo` parameter and the two `data['state']`/`data['district']` lines (`:303-305`); the script prints `tail: list(rl.COPY_COLUMNS[-1:])` and `udr_resource` only.
- `COPY_TAIL = ["udr_resource"]` (`:324`).
- Delete "appends state/district last and copies them as-is" (`:359-367`) and "a RAN_USAGE chunk missing the geo columns fails loud" (`:369-375`).
- Keep and retarget "a usage type that reads no ratecard writes NULL …" (`:377-385`) and every `_resource_value` case (`:386-427`): expected objects lose `state`/`district`.
- **New (regression, D8):** a `RAN_USAGE` frame that *still* carries `state`/`district` columns builds a row whose tuple has no geo value and whose `udr_resource` is copied — proves the columns are ignored, not rejected. Cheap; one case.
- Live-DB block: unchanged (it reads back `udr_resource`, `:1081`, `:1168`, `:1201`).

**`rm07-prp-claim-validate-reject`:**
- `polygonToGeo` / the bm48 block (`:980-1000`): replace with a `polygonToResource` helper (or reuse `polygonToColumn(manifestUri, "udr_resource")`).
- "bm48. the PRP chunk carries each record's matched ratecard cell state/district" (`:1002-1013`) → "Phase J. the PRP chunk carries `udr_resource` and no `state`/`district` column": assert the two columns are **absent** from the chunk schema and `udr_resource` equals `formatUdrResource` of the cell.
- "bm48. … blank state/district labels yields NULL geo" (`:1015-1031`) → assert `udr_resource === "||2026-01-01"` only.
- Case 17 (`:1178-1199`, case-variant cells): assert distinctness via `udr_resource` (the `OTHER` district appears in segment 2), not via a `district` column.
- Case 20 (`RATECARD_LABEL_INVALID`, `:1223-1250`): **unchanged** — it asserts the event code and the refusal, which this unit keeps.

**`rm27-rp-carry-udr-resource`:** the rated Parquet has `udr_resource` and **no** `state`/`district` column (`:229-246` expected shapes lose the two fields; the blank-label graph at `:145-156` still proves `||2026-01-01`).

**`rm08-rp-price-resolution-snapshot`:** `:417-418` fixture fields removed.

**`rm13-e2e-journey`:** `:192-193` assertions removed; `:206-207` stays as `formatUdrResource` input; the comment at `:46` reworded.

### 5. Grep gate (documented command, run before the PR)
`state`/`district` appear in `prp.py` only inside `RatecardCell`, `_RATECARD_SQL`, `extract_ratecard`, `build_udr_resource`, `invalid_label_cells`, `_geo_label` and their docstrings; not at all in `rp.py` or `rl.py` except the `_resource_value` docstring's description of the `udr_resource` segments. `bm48` appears in no runtime module.

## Dependencies

rm31. Reuses `formatUdrResource` (rm25) in the tests; no new helper.

## Verification checklist

- [ ] `COPY_COLUMNS[-1] == "udr_resource"`; `_GEO_OPTIONAL_COLUMNS` and `_geo_value` no longer exist; `_resource_value` is byte-identical except its docstring.
- [ ] `_GEO_COLUMNS == ("udr_resource",)`.
- [ ] A PRP chunk Parquet for the Sample-5G feed has no `state`/`district` column and `udr_resource` on every row; a card with a `|` in a label still refuses the batch (`RATECARD_LABEL_INVALID`).
- [ ] A clean `RAN_USAGE` load against the **unchanged** `0045` schema writes `udr_resource` on every row and `NULL` in the (still present) `state`/`district` columns; a `RAN_USAGE` chunk without `udr_resource` still exits non-zero with zero rows written.
- [ ] A frame that still carries `state`/`district` loads (regression case) — the columns are ignored.
- [ ] `rm07`, `rm08`, `rm09`, `rm13`, `rm27` green via `rmtest-runner:local` (disposable `postgres:17`); `grants` and `rm23` still green (their `state`/`district` assertions are retargeted in rm33, and the columns still exist here).
- [ ] The grep gate (§5) passes; no runtime comment says the geo is carried to `udr_rated.state/district`.
- [ ] The diff touches only `prp.py`, `rp.py`, `rl.py`, the one YAML comment line and the five test files: no migration, no `db/schema/**`, no `db/seeds/**`, no `db/bootstrap/**`, no billing file, no edit to `_GUARD_SQL`, `_SUPERSEDE_SQL`, `_resource_value`'s logic or the constraint.
- [ ] The PR cites the rm32 waiver by name and lands as four ordered commits (RL → RP → PRP → tests).
