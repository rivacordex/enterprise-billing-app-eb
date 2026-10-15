# rm28 — RL: write `udr_resource`, raw-key guards verified — Spec

- **Unit:** rm28 of Phase H (`rm00-build-plan.md`)
- **Repo:** `enterprise-billing-app` (wfm surface) · **Boundary:** `workflow-management/worker/workflow-engine/runtime/rl.py` and `tests/rating/rm09-rl-guarded-transactional-load.integration.test.ts`.
- **Authorizes from:** `_updatemodule-rating-udr-key-resource-plan.md` R4, R5, R7 and §3 (RL); `ratemgmt-architecture.md` Inv 2, 6, 27, 28; `ratemgmt-code-standards.md` §0.1 (Data and Storage 1–2, 6), §10 tests 17 (RL half) and 19 (RL part); `ratemgmt-ai-workflow-rules.md` §0.1 rules 12, 15, 19.
- **Depends on:** rm27 (the rated Parquet carries `udr_resource`). **Land last of the three components:** RL raises on a `RAN_USAGE` chunk without the column, so landing it before PRP (rm26) and RP (rm27) leaves the tree red.

## Goal

Make RL copy `udr_resource` into `rating.udr_rated` at INSERT for every `RAN_USAGE` row, fail loud if a `RAN_USAGE` row arrives without it, and prove — with tests, not code changes — that the billed/in-flight guard, supersession and the live-row constraint all work on raw keys.

## OI-R3 trace (precondition — done 2026-10-14, recorded here and in the plan)

Every place that compares `udr_key` across batches, read from the code:

| Where | Comparison | Effect of raw keys |
|---|---|---|
| `rl.py:336-348` `_GUARD_SQL` | `i.udr_key = ur.udr_key` and `start_datetime`, live rows at `BILL_DRAFT`/`BILL_APPROVED` | Exact match, unchanged. Two keys differing only in case do not collide (accepted, R4). |
| `rl.py:421-429` `_SUPERSEDE_SQL` | selects by `udr_ref_batch_id IN (batches of this file_key with run < N)` | **Not by `udr_key`.** A corrected re-send of the same `file_key` supersedes correctly whatever the key form. |
| `rl.py:464-468` cross-period check | `(udr_key, partition_period) not in incoming_periods` (string equality) | Exact; correct when both runs used raw keys (fresh DB). |
| `rl.py:704-741` `scan_and_guard` | builds `incoming_periods` from the chunk's `udr_key` | Exact. |
| `completeness_check.py:246-251` | `NOT EXISTS … l.udr_key = o.udr_key AND l.start_datetime = o.start_datetime` | Exact; a case-only change between runs reads as "superseded and never replaced", which is the truthful answer for a different key. |
| PRP in-file duplicate digest (`prp.py:1050-1053`) | `(billing month, udr_key)` | Exact; case-variant rows are distinct. |
| `UNIQUE (partition_period, udr_key, is_live)` | byte equality | Exact. |

**Result:** nothing normalises or case-compares a key; supersession is keyed on batch lineage. Raw keys behave consistently inside one DB regime. Mixed-regime false alarms (`CROSS_PERIOD_SUPERSEDE`, superseded-never-replaced) can occur only if a database holds legacy lowercase keys, which this round does not (fresh DB). **No RL code change is needed for raw keys.**

## Design

- **One new COPY column, appended last.** `"udr_resource"` goes after `"district"` in `COPY_COLUMNS` (`rl.py:120-148`). `db.copy_insert(..., COPY_COLUMNS, rows)` (`:851`) and `build_chunk_rows` (`:228-285`) both derive from that tuple, so the insert and the row builder cannot disagree.
- **Stricter than the geo columns, deliberately.** `state`/`district` are `NULL` legitimately (a blank card label) and `_geo_value` (`:288-299`) copies a present `NULL` through. `udr_resource` is never `NULL` for a `RAN_USAGE` row — the card's start date is `NOT NULL`, so the value is at least `||<date>` (plan R5) — so RL checks the **value**, not only the column's presence:
  - column present, non-empty string → copied as is;
  - column present but `NULL` or empty, `RAN_USAGE` → raise;
  - column absent, `RAN_USAGE` → raise `KeyError` (the same loud guard as the geo columns: PRP stamped it and RP carried it, so a gap means the handoff is broken);
  - any other usage type → `NULL`, whether the column is absent or present-but-null.
  A new function `_resource_value(cols, i, udr_type)` (beside `_geo_value`) holds this; `_GEO_OPTIONAL_COLUMNS` is **not** extended, so `state`/`district` semantics are untouched.
- **Failure shape is the existing one.** `build_chunk_rows` errors are not caught by `main()` (only `BatchRefused` and `ReconImbalance` are, `:1201`, `:1229`): the process exits non-zero, the transaction rolls back, nothing is archived, and the batch is left at `PROCESSING` for stranded-batch reconciliation (rm11), exactly like the existing missing-geo `KeyError`. No new event code.
- **No change to the guard, supersession or the constraint** (§0.1 rule 19): the unit proves them on raw keys with tests.
- **No grant change.** `rating_runtime` already holds table-level `INSERT`; no role holds `UPDATE` on `udr_resource` (asserted in rm29).

## Implementation

### 1. `rl.py`
- Append `"udr_resource"` to `COPY_COLUMNS` after `"district"`; extend the comment at `:145` ("bm48 — appended last …") to name it.
- Add `_resource_value(cols, i, udr_type) -> str | None` next to `_geo_value`:
  ```python
  def _resource_value(cols: dict[str, list[Any]], i: int, udr_type: str) -> str | None:
      """``udr_resource`` for one row (Inv 28). RAN_USAGE: required and non-empty;
      other usage types: NULL. Absent column for RAN_USAGE raises KeyError, like
      the geo columns."""
  ```
  Raise `KeyError` (absent column) / `ValueError` (present but `None` or `""`) with a message naming the column, the usage type and the row index.
- In `build_chunk_rows`, after the `_GEO_OPTIONAL_COLUMNS` loop, set `row["udr_resource"] = _resource_value(cols, i, udr_type)`.
- Update the comment block at `:150-154` so it states that `udr_resource` is required for `RAN_USAGE`, whereas `state`/`district` may be `NULL`.

### 2. Tests
**DB-free, in `rm09-rl-guarded-transactional-load.integration.test.ts`** — extend `BUILD_ROW_SCRIPT` (`:205-233`) so the hand-built frame can carry `udr_resource` (value, `None`, or absent) and the script prints it:
1. The tail of `COPY_COLUMNS` is `["state", "district", "udr_resource"]`, and a present value (`"Selangor|DIST-1|2026-01-01"`) is copied as is.
2. A `RAN_USAGE` chunk missing the column fails loud (`ok: false`).
3. A `RAN_USAGE` chunk with the column present but `None`, and another with `""`, each fail loud.
4. A usage type that reads no ratecard (`SMS_USAGE`) writes `NULL` with the column absent and with it present-but-null.
5. The existing geo tests keep their meaning: update their expected `tail` to the three-column tail.

**Live-DB, in the same file's black-box block** (existing helpers `runPrp`/`runRp`/`runRl` and the guard fixtures at `:731-760`, `:779-846`, `:924`):
6. **Written.** A clean `RAN_USAGE` load leaves every `udr_rated` row with `udr_resource` equal to `formatUdrResource` of its cell (guardrail 17, RL half).
7. **Guard on raw keys.** Re-using the suite's `BILL_APPROVED` collision fixture with the raw key read back from the rated Parquet (as the suite already does, `:731`), the batch is still refused whole with `LOAD_BLOCKED_BILLED`, zero rows written.
8. **Case-variant keys both load.** Two `RATED` rows whose keys differ only in the case of the polygon both insert and both stay live (accepted behaviour, R4 — the assertion makes it explicit).
9. **Supersession on raw keys.** A reissue of the same `file_key` (run 2, `_v2` filename) supersedes run 1's raw-key rows, leaves one live row per key, and the new rows carry `udr_resource`.
10. **No `UPDATE`.** An `UPDATE … SET udr_resource` as `rating_runtime` is refused (`permission denied`); the full three-role proof is rm29's.

## Dependencies

None.

## Verification checklist

- [ ] `COPY_COLUMNS[-3:] == ("state", "district", "udr_resource")`; `_GEO_OPTIONAL_COLUMNS` is still `("state", "district")`.
- [ ] A `RAN_USAGE` chunk with `udr_resource` absent, `None` or `""` makes RL exit non-zero, writes zero rows, archives nothing and leaves the batch at `PROCESSING` for rm11.
- [ ] Non-RAN usage types write `NULL`.
- [ ] A clean load writes `udr_resource` on every row; the value equals the PRP/RP value.
- [ ] A raw-key collision with a live `BILL_APPROVED` row is refused whole (`LOAD_BLOCKED_BILLED`); with a live `BILL_DRAFT` row, `LOAD_BLOCKED_INFLIGHT` — both unchanged.
- [ ] Two keys differing only in case both load live; a reissue of the same `file_key` supersedes by batch lineage.
- [ ] The OI-R3 table above is copied into the plan (OI-R3 closed) and `rm00-build-plan.md` open item 12 is marked closed.
- [ ] The rm09 suite (DB-free and black-box blocks) is green; guardrail tests 17 (RL half) and 19 (RL part) pass.
- [ ] The diff touches only `rl.py` and the rm09 test: no `prp.py`, no `rp.py`, no migration, no `db/bootstrap/**`, no flow YAML, no billing file, and no edit to `_GUARD_SQL`, `_SUPERSEDE_SQL` or the constraint.
