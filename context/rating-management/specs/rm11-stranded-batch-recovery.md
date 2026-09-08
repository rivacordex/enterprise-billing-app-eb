# rm11 — Stranded-batch recovery — Spec

- **Unit:** rm11 of rm01–rm13 (`specs/rm00-build-plan.md`, Phase E)
- **Repo:** rating repo · **Boundary:** `flows/**` — `stranded-batch-reconcile`
- **Builds:** a startup + scheduled flow that finds `udr_batch` rows stuck at `PROCESSING` beyond a threshold, resolves them, releases the claim so the file reprocesses, and logs + alarms the outcome.
- **Depends on:** rm07 (the claim), rm09 (the transaction it recovers from).
- **Sources:** `rm00-build-plan.md` Unit rm11 · `_newmodule-rating-engine-plan.md` §9.7 (worker restart, startup reconciliation) · `ratemgmt-architecture.md` Inv #7 (the claim) · rm02 (event catalog — see D5, a coordinated addition).

> **⚠ Cross-spec impact (needs your nod, but I've defaulted):** none of rm02's sixteen event codes name a *stranded batch*. rm11 introduces a **new code `BATCH_STRANDED`** (D5), which means a coordinated update to `rm02` and `ratemgmt-code-standards.md` §7. Reusing `TASK_RETRY_OK` was the alternative; a distinct code is cleaner because a dead worker mid-load is a distinct operational condition. Flag if you'd rather reuse an existing code.

---

## Goal

Detect `udr_batch` rows stranded at `PROCESSING` by a killed worker, resolve them explicitly (fail them and release the claim), and let the file reprocess — so a worker relocation never leaves a file permanently claimed and unrateable, and the recovery is visible as an alarm rather than silent.

---

## Design

### D1. Why recovery exists — the claim becomes a blocker

Container Apps relocates containers, so a worker can be killed mid-processing (§9.7), leaving an execution that may sit `RUNNING` indefinitely and a `udr_batch` row stuck at `PROCESSING`. **Without recovery, the claim (`UNIQUE (file_key, batch_run_num)`) that protects correctness becomes the thing that blocks recovery** — the file is permanently claimed and never reprocessed.

### D2. "Stranded" is safe to fail — because RL commits atomically

RL's guard + supersede + insert are **one transaction** (rm09 D1). So a batch stuck at `PROCESSING` **beyond the threshold** means the RL transaction **did not commit** — its rows rolled back, and the raw file is still in `landing/` (archive happens only after commit, rm09 D6). Therefore a stranded batch can be **failed and released** without risk of orphaning committed rows.

### D3. Find and resolve

The reconcile finds `udr_batch` rows in a **non-terminal** status — `RECEIVED` **or** `PROCESSING` — whose age exceeds the threshold, and resolves each: set `status = 'FAILED'`, releasing the file so a subsequent run (`batch_run_num = N+1`, rm07) can claim and reprocess it. The raw file is already in `landing/`; the next file-trigger or manual run picks it up. Supersession (rm10) then retires nothing (the failed run loaded nothing) and the reprocess loads cleanly.

**Both non-terminal states are stranded (corrects an earlier PROCESSING-only reading).** rm07's PRP commits the claim as `RECEIVED` **before** it parses (`prp.claim_batch`: "the claim is durable BEFORE parsing … a parse crash leaves this RECEIVED row for stranded-batch reconciliation (rm11)"), then stamps `PROCESSING` + `started_at` with the parse counts. So a worker killed mid-parse strands the row at `RECEIVED` (with `started_at` still NULL), and one killed in RP/RL strands it at `PROCESSING`. A `PROCESSING`-only find would leave `RECEIVED` strands permanently claimed — exactly the D1 failure this unit exists to prevent. Age is therefore measured from `COALESCE(started_at, received_at)` (`received_at`, the NOT-NULL claim time, is the floor while `started_at` is unstamped). The threshold (D4) must accordingly exceed worst-case **parse** time as well as RP/RL time; if it is ever set below a live parse and a genuinely-running `RECEIVED` batch is failed, the reprocess is still correct (rm10 supersedes the earlier run) but wasteful.

### D4. Threshold config — operational, KV store

The `PROCESSING`-age threshold is **namespace KV** config (operational, not output-affecting — rm00 §Configuration). It must be long enough not to fail a genuinely-running large batch, short enough to recover promptly.

### D5. Logged and alarmed — the new `BATCH_STRANDED` code

Resolving a stranded batch emits **`BATCH_STRANDED`** at `MAJOR` (`component = SCHEDULER`), on the **run-independent delivery `alarm_key` `<udr_type>:<file_key>`**, **auto-clearing** by the reprocessed batch's `BATCH_COMPLETE`. This code is **not** in rm02's sixteen; rm11 adds it in a coordinated change: the seed row in `rm02`, its entry in `ratemgmt-code-standards.md` §7, and the emitting code — per ai-workflow-rules §7.3.

**The `alarm_key` MUST be the delivery key, not a run-scoped one (corrects this spec's own earlier example).** Alarms pair a raise to its clearer by matching `alarm_key`, and `BATCH_COMPLETE` is stamped with `<udr_type>:<file_key>` (`rl.emit_terminal_event`). An earlier draft here suggested `BATCH_STRANDED:<file_key>:<run>`, but the reprocess runs under `batch_run_num = N+1` and emits its `BATCH_COMPLETE` on the delivery key — so a run-scoped, prefixed `alarm_key` could **never** be matched by its clearer, and the `MAJOR` alarm would never clear (violating verification item 6). Using `<udr_type>:<file_key>` is what makes D5's own "auto-clearing by the reprocessed batch's `BATCH_COMPLETE`" and verification item 6 true. The alarm is also emitted **before** the `FAILED` commit (at-least-once: a crash in the window duplicates on the same delivery key rather than silently reaping a strand with no alarm).

### D6. Idempotent and safe

Running the reconcile twice is safe — an already-resolved batch is skipped. It touches **only** batches beyond the threshold; a genuinely-running batch within the threshold is untouched.

### D7. Startup **and** scheduled

The reconcile runs **on flow start** (startup reconciliation, §9.7 — a worker coming up clears strands left by its predecessor) **and** on a schedule (so a strand does not wait for the next file to arrive).

---

## Implementation

### 1. `flows/stranded-batch-reconcile.yaml`

A flow with a **schedule** trigger and an **on-start** hook; calls `stranded_reconcile.py`.

### 2. The find query (`stranded_reconcile.py`)

```sql
SELECT batch_id, file_key, batch_run_num, source_file, udr_type,
       started_at, received_at
FROM   rating.udr_batch
WHERE  status IN ('RECEIVED', 'PROCESSING')
  AND  now() - COALESCE(started_at, received_at) > $threshold;
```

### 3. Resolve + log

For each: `UPDATE rating.udr_batch SET status = 'FAILED' WHERE batch_id = $id AND status IN ('RECEIVED','PROCESSING')` (guarded so an already-resolved or self-finalized row is a no-op); emit `BATCH_STRANDED` (`MAJOR`, `alarm_key = <udr_type>:<file_key>` — the delivery key, so the reprocessed batch's `BATCH_COMPLETE` clears it) **before** committing the resolve. The file remains in `landing/` for reprocessing.

### 4. Threshold config

Read the `PROCESSING`-age threshold from the namespace KV store.

### 5. Catalog addition (coordinated)

Add `BATCH_STRANDED` to `rm02`'s seed and `RATING_EVENT_CODES`, and to `ratemgmt-code-standards.md` §7, in the same change set as this unit.

---

## Dependencies (packages to install)

**None new.** `psycopg` is in the rm04 worker image. No npm packages.

---

## Verification checklist

Live database + engine.

1. A worker killed mid-load leaves the source file in `landing/`, **zero** rows in `udr_rated`, and a `udr_batch` row stranded at `PROCESSING`.
2. The reconcile finds it beyond the threshold, resolves it (`FAILED`, claim released), and the file **reprocesses cleanly** as a new run.
3. **Without this unit**, the file stays permanently claimed and is never reprocessed — asserted by running the pipeline without the reconcile and showing the stuck claim.
4. A genuinely-running batch **within** the threshold is **untouched**.
5. The reconcile is **idempotent** — running it twice resolves each strand once.
6. `BATCH_STRANDED` is emitted at `MAJOR` and **cleared** by the reprocessed batch's `BATCH_COMPLETE` on the same `alarm_key`.
7. `BATCH_STRANDED` resolves in `event_catalog` (the coordinated rm02 addition) — the `INDETERMINATE` count stays zero.
8. The reconcile runs both on flow start and on schedule.
