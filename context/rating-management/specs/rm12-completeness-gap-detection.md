# rm12 — Completeness and gap detection — Spec

- **Unit:** rm12 of rm01–rm13 (`specs/rm00-build-plan.md`, Phase F)
- **Repo:** rating repo · **Boundary:** `flows/**` — `completeness-check`
- **Builds:** expected-cadence config per `udr_type`; a scheduled check raising clearable `FILE_NOT_RECEIVED` / `FILE_LATE`; alarm clearing; and superseded-never-replaced detection.
- **Depends on:** rm01 (`udr_batch`, the orphan index), rm02 (catalog + clearing metadata), rm10 (supersession, so there is something to detect).
- **Config introduced:** expected cadence + window per `udr_type` (**KV store** — drives an alarm only).
- **Sources:** `rm00-build-plan.md` Unit rm12 · `_newmodule-rating-engine-plan.md` §5 (completeness), §6.5, §8.4 (clearing) · `ratemgmt-project-overview.md` goals 5 & 6, success criteria 5, 10, 11 · rm02 D5 (auto-clearing).

---

## Goal

Turn **absence into a signal**: a scheduled check compares `rating.udr_batch` against the expected arrival cadence per `udr_type`, raises a clearable `FILE_NOT_RECEIVED` (or `FILE_LATE`) where there was only silence, clears the alarm when the file lands, and surfaces usage that was superseded and never replaced — so a missing file and a shrinking-reissue tail are both queryable rather than invisible.

---

## Design

### D1. Absence is the one gap the pipeline cannot see

A file that never arrives produces no error, no reject, and no log entry — only silence, which looks exactly like success (overview goal 5). The completeness check is the **only** place the "expected vs received" fact can live, because it exists at the landing directory and nowhere else (§5).

### D2. Expected-cadence config per `udr_type` (KV store)

The expected arrival **cadence and window** per `udr_type` (e.g. `RAN_USAGE` daily, expected by 06:00) is **namespace KV** config — it drives an alarm only, changes no rated number (rm00 §Configuration).

### D3. The check — `FILE_NOT_RECEIVED` / `FILE_LATE`

A scheduled flow compares `udr_batch` against the expected cadence:
- an expected delivery **absent** → **`FILE_NOT_RECEIVED`** at `MAJOR`, with an `alarm_key` (e.g. `FILE_NOT_RECEIVED:RAN_USAGE:2026-08-21`);
- an arrival **outside** its window → **`FILE_LATE`** at `WARNING`.

### D4. Alarm clearing — only for auto-clearing codes (rm02 D5)

X.733 alarms are **stateful**: a raise with no clear leaves monitoring showing a permanent `MAJOR` for a problem long fixed (§8.4). A later successful batch emits a **`CLEARED`** row against the **same `alarm_key`** — but **only for codes whose catalog row has `is_auto_clearing = true`** (`FILE_NOT_RECEIVED`, `FILE_LATE` are). `LOAD_BLOCKED_BILLED`, `RECON_IMBALANCE`, `SHRINKING_REISSUE`, `FILE_KEY_UNRESOLVED`, `CURRENCY_MISMATCH` are **not** auto-cleared — a later clean batch does not make the earlier problem untrue, and clearing them would erase the evidence (rm02 D5).

### D5. Superseded-never-replaced detection (§6.5)

Natural keys whose rows are **all non-live** (`is_live IS NULL` for every row of the key) are usage that was superseded and never re-rated — the shrinking-reissue tail, the revenue-leakage case. Surfaced by querying the **orphan index** (`udr_rated_orphan_idx ON (udr_key) WHERE is_live IS NULL`, rm01) and confirming no live sibling exists. Queryable rather than invisible.

### D6. Zero-activity accounts are **not** here — the boundary

"Expected usage that never arrived" for a **zero-activity account** has no row at all, so it is **structurally unrepresentable** in rating (rm01 status model; overview). That derivation — scoped accounts minus accounts present in `udr_rated` for the period — is the **bill run's** problem, not rm12's. rm12 detects **file-level** absence (`FILE_NOT_RECEIVED`) and **superseded-never-replaced** usage; it does not derive zero-activity accounts. State the boundary so nobody expects it here.

---

## Implementation

### 1. `flows/completeness-check.yaml`

A scheduled flow calling `completeness_check.py`.

### 2. Expected-cadence config

Read the per-`udr_type` cadence + window from the namespace KV store.

### 3. Absence / lateness detection (`completeness_check.py`)

For each `udr_type`, compare the expected deliveries for the period against `udr_batch`; raise `FILE_NOT_RECEIVED` (`MAJOR`) for a missing one, `FILE_LATE` (`WARNING`) for a late one, each with its `alarm_key`.

### 4. Clearing

When a previously-missing/late delivery lands and completes, emit `CLEARED` against the same `alarm_key` — **only** if the code's `event_catalog.is_auto_clearing` is true.

### 5. Superseded-never-replaced query

```sql
SELECT DISTINCT o.udr_key
FROM   rating.udr_rated o
WHERE  o.is_live IS NULL
  AND  NOT EXISTS (
         SELECT 1 FROM rating.udr_rated l
          WHERE l.udr_key = o.udr_key AND l.start_datetime = o.start_datetime
            AND l.is_live);
-- keys retired and never re-rated → surfaced for investigation.
```

---

## Dependencies (packages to install)

**None new.** `psycopg` is in the rm04 worker image. No npm packages.

---

## Verification checklist

Live database + engine.

1. A file that simply **never arrives** raises `FILE_NOT_RECEIVED` at `MAJOR` where previously there was only silence (success criterion 5).
2. When the late file lands and completes, it **clears** that alarm — a `CLEARED` row on the same `alarm_key` (criterion 11).
3. An arrival outside its window raises `FILE_LATE` at `WARNING`.
4. **Only auto-clearing codes clear:** a later clean batch does **not** clear `LOAD_BLOCKED_BILLED`/`RECON_IMBALANCE`/`SHRINKING_REISSUE` on their alarm keys.
5. Usage **superseded and never replaced** is returned by the orphan query — queryable rather than invisible.
6. **Boundary:** zero-activity accounts are **not** reported by rm12 (that derivation is the bill run's); the check surfaces only file absence and superseded-never-replaced usage.
7. Every emitted code (`FILE_NOT_RECEIVED`, `FILE_LATE`, `CLEARED`) resolves in `event_catalog`; the `INDETERMINATE` count stays zero.
