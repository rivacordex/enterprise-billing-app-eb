# rm26 — PRP: raw `udr_key`, exact rate-card match, cell label — Spec

- **Unit:** rm26 of Phase H (`rm00-build-plan.md`)
- **Repo:** `enterprise-billing-app` (wfm surface) · **Boundary:** `workflow-management/worker/workflow-engine/runtime/prp.py` (+ the `runtime/__init__.py` docstring) and `tests/rating/rm07-prp-claim-validate-reject.integration.test.ts`.
- **Authorizes from:** `_updatemodule-rating-udr-key-resource-plan.md` R1–R3, R5, R9; `ratemgmt-architecture.md` Inv 27, 28; `ratemgmt-code-standards.md` §0.1 (general rules 1–6, Python names), §10 tests 17 (PRP half), 18, 20; `ratemgmt-ai-workflow-rules.md` §0.1 rules 7, 12.
- **Depends on:** rm21 (the PRP checks this edits), rm23 (`state`/`district` already on the cell), rm25 (`RATECARD_LABEL_INVALID` row and `formatUdrResource`, which the tests use). **No flow YAML change.**

> **Reversed 2026-10-27 (Phase J, rm32 — `_change-rating-drop-udr-rated-geo-columns-plan.md` D1/D3) — the `state`/`district` chunk columns only.** `ParsedRow` and `_chunk_frame` lose them, and the rm07 "bm48" cases assert `udr_resource` only. Nothing about `udr_resource` changes: `build_udr_key`, the exact cell match, `RatecardCell.state`/`.district` as the inputs to `udr_resource = state|district|polygon_start_date`, and the `|` check all stand. Delivered text below is unchanged.

## Goal

Make PRP store each record's `udr_key` exactly as the feed sent it, match records to rate-card cells by exact comparison, and stamp every matched record with the cell's `udr_resource` (`state|district|polygon_start_date`), refusing the whole batch if a card label contains `|`.

## Design

- **One key builder, no normaliser.** `canonical_udr_key` and `_normalise_value` (`prp.py:581-602`) are replaced by `build_udr_key`: key names in the profile's sorted order, `name=value` with the value untouched, joined by `|`. The shape is unchanged (owner confirmed 2026-10-13), so the `polygon_id=` segment still parses. No alias for the old names is kept (§0.1 rule 1).
- **The same builder on both sides of the match.** The ratecard index is keyed by `build_udr_key` over the card's raw `mno_public_key`, `commercial_unit_public_key`, `polygon_id`, and each record's `udr_key` is built by the same function over its raw feed values. A record matches its cell only if all three values are identical byte for byte, so a case or whitespace difference is the existing whole-batch `INPUT_UNMAPPED` hard-stop. Under `HARD_STOP` the unmatched card cell also surfaces as `RATECARD_COVERAGE_GAP` — both are existing behaviour.
- **MNO resolution still strips.** `mno = row.values[profile.mno_column].strip()` (`prp.py:1068`) feeds `resolve_mno`; the owner's 2026-10-05 decision is that the MNO match is exact in the database. This unit does not change it. Consequence, documented by a test: a feed MNO with a trailing space resolves the subscriber but misses the card, so the batch stops as `INPUT_UNMAPPED`.
- **The card-index collision guard stays, reworded.** `extract_ratecard` keeps `if cell in index: raise ValueError(...)` (`prp.py:470`). Case and whitespace variants no longer collide (they are distinct raw cells, and the DB constraint `ratecard_ran_usage_lkp_row_key_unique` already rejects exact duplicates), so the guard now only fires on a serialisation collision, for example a key value containing `|` or `=`. Removing it would let such a collision silently overwrite a cell. This refines the plan's "remove the collision `ValueError`": remove the case/whitespace *rationale and message*, keep the fail-closed guard.
- **The label is built once per card cell, not per record.** `extract_ratecard` computes `RatecardCell.udr_resource` with `build_udr_resource`; enrichment copies it onto the record (Inv #10 spirit: no per-record work).
- **The `|` check is a post-claim, whole-batch refusal** — the same pattern as `UDRTYPE_MISMATCH` (`prp.py:1619-1665`): claim the batch, find the offending cells, stamp the batch `REFUSED`, emit one summarised line, exit 1. A pre-claim `ValueError` was rejected because it prints to stderr only (no catalogued event, no batch row), which would give Ops no alarm. `RATECARD_LABEL_INVALID` is `MAJOR`, non-auto-clearing (rm25); the remedy is to fix the card and re-drop the file (the same `file_key` gets the next `batch_run_num`).
- **Do not duplicate the refusal tail.** The `UDRTYPE_MISMATCH` block (stamp counts, emit summary, stderr line, return 1) is extracted into one private helper and both refusals call it; the existing `UDRTYPE_MISMATCH` test must stay green. This is the only refactor in the unit and exists because a second copy would be pure duplication.
- **The chunk gains one column.** `udr_resource` (nullable `Utf8`) beside `state`/`district` in the Parquet; it is never null for a matched `RAN_USAGE` record because the card's start date is `NOT NULL`.
- **Out of scope:** RP and RL (rm27, rm28), seeds (rm29), the `state`/`district` columns, the `service_code` strip-and-empty-to-NULL rule (`prp.py:479-483`, not a key dimension).

## Implementation

### 1. Key builder (`prp.py`)
Delete `_normalise_value` and `canonical_udr_key`. Add:
```python
def build_udr_key(profile: FeedProfile, row: dict[str, str]) -> str:
    """Serialise the profile's key columns into ``udr_key`` / the ratecard cell:
    key names in sorted order, each value EXACTLY as supplied (no trim, no case
    fold - Inv 27), ``name=value`` joined by ``|``, e.g.
    ``commercial_unit=<v>|mno_public_id=<v>|polygon_id=<v>``."""
    return "|".join(f"{name}={row[name]}" for name in profile.sorted_key_columns)
```
Call sites: `extract_ratecard` (`:455`) and `validate_row` (`:768`, `row.udr_key = build_udr_key(profile, values)`). `validate_row`'s `MISSING_KEY_FIELD` check (`:729-733`, `values[name].strip()` emptiness) is unchanged: a blank or whitespace-only value is still missing, but a non-blank value is stored as sent.

### 2. Rate-card query, cell and index (`prp.py`)
- `_RATECARD_SQL` (`:434-441`): add `l.polygon_start_date` to the SELECT list.
- `RatecardCell` (`:421-431`) gains `polygon_start_date: date` and `udr_resource: str`.
- Add one label builder, used only here:
  ```python
  def build_udr_resource(state: str | None, district: str | None, polygon_start_date: date) -> str:
      """``state|district|polygon_start_date`` (Inv 28): ISO date, an empty segment for a blank label."""
      return f"{state or ''}|{district or ''}|{polygon_start_date.isoformat()}"
  ```
  `state`/`district` are the existing `_geo_label` outputs (`None` for blank, otherwise the stored text exactly).
- `extract_ratecard` (`:444-487`): key each row with `build_udr_key(profile, {profile.mno_column: str(r["mno_public_key"]), profile.commercial_unit_column: str(r["commercial_unit_public_key"]), profile.polygon_column: str(r["polygon_id"])})` — raw `str(...)`, no other processing. Reword the guard message to "two ACTIVE lkp rows serialise to the same udr_key {cell!r} — the ratecard is ambiguous; fix the ratecard data." and replace the comment block at `:463-469` (it describes casefold collapsing) with one that says why the guard remains. Build `udr_resource` from the row and store it on the cell.

### 3. Label check and refusal (`prp.py`)
- Add:
  ```python
  def invalid_label_cells(ratecard: dict[str, RatecardCell]) -> list[dict[str, str]]:
      """Cells whose state or district contains ``|`` (R9), sorted by cell for a stable log."""
  ```
  It returns `{"cell": <key>, "column": "state" | "district", "value": <label>}` for each offender.
- In `main()`, after the `UDRTYPE_MISMATCH` block and before `process_file(...)`, if `invalid_label_cells(ratecard)` is non-empty: build an `Outcome(status="REFUSED", event_code="RATECARD_LABEL_INVALID", log_level="ERROR", parsed=0, rejected=0, discarded=0, specific_problem=f"{n} ratecard cell(s) in card {pin.card_name!r} have a state or district containing '|'", additional_info={"file_key": file_key, "card_name": pin.card_name, "invalid_label_count": n, "sample": offenders[:20]}, alarm_key=_batch_alarm_key("RATECARD_LABEL_INVALID", args.udr_type, file_key, batch_run_num), managed_object=file_key)` and hand it to the shared refusal helper (design). Stderr label: `RATECARD_LABEL_INVALID: batch <id> REFUSED`.
- The refusal leaves zero chunks and no `udr_rated` rows; the file stays in `landing/`.

### 4. Enrichment and chunk (`prp.py`)
- `ParsedRow` (`:681-696`): add `udr_resource: str | None = None` after `district`.
- Enrichment (`:1146-1148`): add `row.udr_resource = ratecard_cell.udr_resource`.
- `_chunk_frame` (`:823-869`): add `"udr_resource": pl.Series([r.udr_resource for r in chunk], dtype=pl.Utf8)` after `district`, with a comment that RP passes it to RL's COPY onto `udr_rated.udr_resource`. The forensic `key__<name>` columns stay.

### 5. Comments and docstrings that describe canonical behaviour
Rewrite so none says "canonical", "normalised" or "casefold" about the key: module docstring `:28-29`; `FeedProfile` comment `:178-179`; `extract_ratecard` docstring `:447-451` and comment `:463-469`; the MNO-match comment `:517-523` (it says the cell "casefolds for the ratecard match" — now the cell is exact and only the MNO *resolution* strips); the section banner and docstrings `:576-602`; the comment at `:765`; and the `runtime/__init__.py:26` docstring ("canonical `udr_key`"). Cite `_newmodule-rating-engine-plan.md` §4.2 only inside a "reversed" remark, never as the rule's source.

### 6. Tests (`tests/rating/rm07-prp-claim-validate-reject.integration.test.ts`)
Reuse the suite's helpers (`seedBaseScenario`, `cleanRow`/`cleanRows`, `writeUdr`, `runPrp`, `readParquetColumn`, `eventCodes`, `polygonToGeo`). Add a describe block "rm26 — raw key and cell label":
1. **Raw key preserved.** The clean file's `udr_key` column equals `buildRawUdrKey` (rm25) of each row and contains `polygon_id=PCU-042_04` in upper case (the old behaviour lowercased it); `key__polygon_id` equals the polygon segment.
2. **Mixed case and space.** A card and feed using polygon `Ab C_1` produce a key containing `polygon_id=Ab C_1`.
3. **Exact match.** A feed polygon that differs from the card only by case, and another by a trailing space, each stop the batch as `INPUT_UNMAPPED`, status `REFUSED`, no chunk.
4. **MNO padding.** A feed MNO `"MNO-X "` resolves the subscriber but the batch stops as `INPUT_UNMAPPED`.
5. **Case-variant cells are distinct.** A card with `PCU-042_04` and `pcu-042_04` (district `OTHER`) and a feed row for each: no `DUPLICATE_IN_FILE`, two distinct keys, each stamped with its own district.
6. **`udr_resource` carried.** The chunk's `udr_resource` for each Sample-5G cell equals `formatUdrResource({ state: SAMPLE_5G_RATECARD_STATE, district: <cell district>, polygonStartDate: SAMPLE_5G_START_DATE })`, i.e. `STATE-1|DIST-1|2026-01-01`.
7. **Blank labels.** Replace the existing "bm48. … blank state/district labels yields NULL geo" expectation so it also asserts `udr_resource === "||2026-01-01"`; `state`/`district` stay `None` as today.
8. **Label delimiter.** A card whose cell has `state = "A|B"` (and a second case with `district = "X|Y"`): `runPrp` exits non-zero; `udr_batch.status = REFUSED`; exactly one summarised line with `RATECARD_LABEL_INVALID`; no chunk and no `udr_rated` rows; after fixing the card, a re-drop of the same filename claims `batch_run_num = 2` and reaches `PROCESSING`.
9. **Replace** the test at line 1002 ("a duplicate canonical cell on the ACTIVE card still fails closed before any claim"): its premise (a case-variant is a collision) no longer holds. Its replacement is test 5 above; add one test that a genuine serialisation collision (two cells whose key values differ only by moving a `|` or `=`) still fails closed before any claim.
10. **Unchanged behaviour stays green:** the `UDRTYPE_MISMATCH`, `INPUT_UNMAPPED`, `RATECARD_COVERAGE_GAP`, `SERVICE_CODE_MISMATCH`, same-cell/same-month duplicate (R2) and different-month pair tests.

## Dependencies

None. `polars` and `psycopg` are already in the worker image; no package is added.

## Verification checklist

- [ ] `build_udr_key` exists; `canonical_udr_key` and `_normalise_value` do not; a search of `prp.py` and `runtime/__init__.py` for `casefold`, `.lower(`, `canonical` finds nothing that touches a key value (the `service_code` strip is the only allowed normalisation).
- [ ] A record for polygon `PCU-042_04` loads with `polygon_id=PCU-042_04` (upper case) in `udr_key` and in `key__polygon_id`.
- [ ] A case- or whitespace-different polygon, and a padded MNO, each stop the whole batch as `INPUT_UNMAPPED`.
- [ ] Case-variant card cells are distinct cells; a serialisation collision still fails closed before any claim.
- [ ] Every Sample-5G chunk row carries `udr_resource = STATE-1|DIST-n|2026-01-01`; blank labels give empty segments (`||2026-01-01` for both blank).
- [ ] A `|` in a card `state` or `district` refuses the batch with one `RATECARD_LABEL_INVALID` line, status `REFUSED`, zero chunks; fixing the card and re-dropping the file succeeds as run 2.
- [ ] `RATECARD_LABEL_INVALID` resolves in `event_catalog` (rm25); the `INDETERMINATE` count is zero.
- [ ] The `UDRTYPE_MISMATCH` test still passes after the shared refusal helper is extracted; there is one refusal tail, not two copies.
- [ ] The rm07 suite is green against a live database with `python3` and the worker runtime; guardrail tests 17 (PRP half), 18 and 20 pass.
- [ ] The diff touches only `prp.py`, `runtime/__init__.py` and the rm07 test: no migration, no `db/bootstrap/**`, no flow YAML, no billing file, no change to `rp.py` or `rl.py`.
