# rm10 — Supersession and reprocessing — Spec

- **Unit:** rm10 of rm01–rm13 (`specs/rm00-build-plan.md`, Phase E)
- **Repo:** rating repo · **Boundary:** `flows/**` — the `rl` section, extended (fills rm09's supersede hook)
- **Builds:** batch-level supersession by `file_key` across all partitions, cross-period detection, shrinking-reissue detection, and the batch-level lineage stamps.
- **Depends on:** rm09 (the RL transaction and its supersede hook).
- **Sources:** `rm00-build-plan.md` Unit rm10 · `ratemgmt-architecture.md` Inv #5, #3, #8 · `rm01-rating-schema-foundation.md` D11 (batch-level lineage + the supersede predicate) · `ratemgmt-code-standards.md` §5.11 · `_newmodule-rating-engine-plan.md` §6.2 (batch supersession), §6.5 (shrinking reissue), §6.7 (single table).

---

## Goal

Fill rm09's supersede hook: on a reissue (`batch_run_num = N`), mark every live row of the same `file_key` from a prior run as `SUPERSEDED` — **across all partitions**, touching only `status` — record the lineage once on the retired `udr_batch` row, detect a shrinking reissue, then let rm09's insert load the run-N rows, all in the **same** transaction. A reissue leaves exactly one live row per natural key (including corrected-timestamp rows in a different partition), and a file smaller than its predecessor raises `MAJOR` rather than silently losing records.

---

## Design

### D1. Batch-level supersession by `file_key`, `status`-only (Inv #5, rm01 D11)

Supersession is **by `file_key`, not by record** — upstream reissues whole files, and a corrected record may carry a corrected `start_datetime` and therefore a different natural key that record-level matching would never find (§6.2). Mark every live row from a prior batch of the same `file_key` as `SUPERSEDED`; **`status` is the only column the update touches**. The lineage — `superseded_by_batch_id`, `supersede_reason` — is recorded **once on the retired `udr_batch` row** (rm01 D11), because predecessors are marked **before** the successors exist, so a per-row successor pointer is not populatable. **There is no `superseded_by_udr_id` on `udr_rated`**; a specific row's successor is derivable (the live row with the same natural key), which the unique constraint guarantees is unique.

### D2. Across all partitions (Inv #5)

The supersede query is scoped **across all partitions**, never the current period. A corrected timestamp crossing a month boundary otherwise escapes — and it escapes the unique constraint too, since the constraint cannot see across partitions. A supersession that crosses a boundary emits **`CROSS_PERIOD_SUPERSEDE`** at `WARNING`.

### D3. The supersede predicate (rm01 D11)

```sql
UPDATE rating.udr_rated SET status = 'SUPERSEDED'
 WHERE is_live
   AND udr_ref_batch_id IN (
         SELECT batch_id FROM rating.udr_batch
          WHERE file_key = $file_key AND batch_run_num < $N);
```

Keys on **`file_key`**, never `source_file` (Inv #5). Then set `superseded_by_batch_id = <run-N batch_id>` and `supersede_reason` on the **retired `udr_batch` rows**. `udr_batch` is small and `udr_ref_batch_id` is indexed, so this is cheap, and it makes `udr_batch` the single authority on which batches exist for a file.

### D4. Shrinking-reissue detection (§6.5)

If run N omits records run N−1 contained (truncated export, partial extract), D3 supersedes them and rm09's insert never replaces them — **silent revenue loss, no error anywhere**. So `udr_batch` compares the run-N record count against run-(N−1); a smaller reissue raises **`SHRINKING_REISSUE`** at `MAJOR`. Stamp `superseded_count` on the batch.

### D5. In the same transaction as the load (Inv #8)

The supersede and the insert are **one transaction** — rm09's. rm10 fills rm09's `# STUB: rm10` hook, immediately before the insert, inside the transaction. Superseding an already-superseded row is a **no-op**, which is what makes flow-level recovery (re-running the batch) safe.

### D6. Superseded rows stay in `udr_rated` (§6.7)

No history table, no `DELETE` grant on the revenue table. Superseded rows carry `is_live = NULL` and coexist without limit under `NULLS DISTINCT`. Reprocessing is rare, so the volume does not justify a second table.

---

## Implementation

### 1. Fill rm09's supersede hook (`rl.py`)

Inside the RL transaction, before the insert: run D3's `UPDATE`, then stamp lineage on the retired `udr_batch` rows.

### 2. Cross-period detection

If any superseded row's `partition_period` differs from the run-N period, emit `CROSS_PERIOD_SUPERSEDE` (`WARNING`).

### 3. Shrinking-reissue check

Compare `count(run N)` against `count(run N−1)` from `udr_batch`; if smaller, emit `SHRINKING_REISSUE` (`MAJOR`). Stamp `superseded_count`.

### 4. Lineage stamps

`superseded_by_batch_id` and `supersede_reason` on the retired `udr_batch` rows (never on `udr_rated`).

---

## Dependencies (packages to install)

**None new.** `psycopg` (the supersede `UPDATE` in rm09's transaction) is in the rm04 worker image. No npm packages.

---

## Verification checklist

Live database + engine.

1. A reissued file supersedes **exactly** the prior run's live rows for that `file_key` and leaves **one** live row per natural key.
2. Rows whose **corrected timestamp** moved them into a **different partition** are still superseded (cross-partition scope), and `CROSS_PERIOD_SUPERSEDE` is emitted at `WARNING`.
3. A reissued file **smaller** than its predecessor raises `SHRINKING_REISSUE` at `MAJOR` rather than silently losing the missing records.
4. **The proof (test #4):** a test that deliberately **omits** the supersede step aborts on the unique constraint rather than double-loading.
5. **Four** consecutive reprocessings of one record leave four `SUPERSEDED` rows and one live row; each retired **batch** points at the batch that replaced it (batch-level lineage).
6. The supersede `UPDATE` touches **only `status`**; there is no `superseded_by_udr_id` column on `udr_rated`; lineage is on `udr_batch` (`superseded_by_batch_id`, `supersede_reason`).
7. The supersede keys on **`file_key`**, never `source_file` (test #7 scope).
8. Supersede + insert are one transaction; superseding an already-superseded row is a no-op.
9. Superseded rows remain in `udr_rated` with `is_live` NULL; no role holds `DELETE`.
