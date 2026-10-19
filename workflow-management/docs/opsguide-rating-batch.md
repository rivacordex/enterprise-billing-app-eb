# Rating batch operations — reloading usage and failing a batch

Runbook for operators of the **RAN-usage rating flow**
(`rating.rating-engine-ran-usage`). It covers how to:

- release a batch that is stuck (`RECEIVED` / `PROCESSING`) by marking it `FAILED`;
- reload a usage file after a failed, refused or partial run;
- replace the data of a file that already rated (a reissue);
- get the trigger to pick up a file it is ignoring.

Design authority: `context/rating-management/ratemgmt-architecture.md` (Inv #3,
#5, #6, #7, #9, #15) and the module docstrings in
`workflow-management/worker/workflow-engine/runtime/` (`prp.py`, `rl.py`,
`stranded_reconcile.py`). If this guide and the code disagree, the code wins.
Fix the guide.

> Written from the first live local run (2026-10-18, bm73 manual run). Commands
> are shown for the **local dev stack**. On Azure, run the same SQL as an admin
> role over the VPN and the same Python module on the `workflow-engine`
> Container App console (see `infra/docs/engine-access.md`). The Azure console
> path is not yet verified.

---

## 1. Where things are

| What | Local dev | Notes |
|---|---|---|
| Usage file drop | `workflow-management/dev/landing/` (`/data/landing` in the container) | The trigger polls it every minute |
| Rated files | `workflow-management/dev/archive/` | RL moves a file here only **after** its rows commit |
| Rejected rows / parked files | `workflow-management/dev/error/` | PRP writes reject files here; also a safe place to park a superseded file |
| Kestra UI | http://localhost:8085 | Executions, logs, KV store (namespace `rating`) |
| Batches | `rating.udr_batch` | One row per file delivery (claim) |
| Rated rows | `rating.udr_rated` | `udr_ref_batch_id` points at the batch |
| Events | `rating.process_log` | One summarised line per event, keyed by `batch_id` |

Local SQL shell:

```bash
docker exec -it enterprise-billing-app-db-1 psql -U postgres -d enterprise_billing
```

---

## 2. How a delivery becomes a batch

```
landing/<file>  ──trigger──▶  prp (claim + parse + validate)  ──▶  rp (price)  ──▶  rl (guard + supersede + load, ONE transaction)  ──▶  archive/
```

- **The filename decides the file key.** It must match
  `rating-input-file-<YYYYMMDDHHMI>[_vN].udr`. The `file_key` is the name
  **without** `_vN`, so `rating-input-file-202609010000_v3.udr` has file key
  `rating-input-file-202609010000`.
- **prp claims before it parses.** It inserts the `udr_batch` row as `RECEIVED`
  with `batch_run_num = max(batch_run_num for this file_key) + 1`, then stamps
  `PROCESSING` with the parse counts.
- **rl is all-or-nothing.** The bill-run guard, supersession and the `COPY`
  insert are one transaction. If rl fails, **zero rows** are loaded and the file
  stays in `landing/`.

### Batch statuses

| Status | Terminal? | Meaning | Rows loaded |
|---|---|---|---|
| `RECEIVED` | no | Claimed, not yet parsed (or parse crashed) | 0 |
| `PROCESSING` | no | Parsed. rp/rl running, or **stranded** if the run died | 0 |
| `COMPLETE` | yes | Every parsed record rated | all |
| `PARTIAL` | yes | Some records rejected/discarded (e.g. `LOOKUP_MISS`) within threshold | the rated subset |
| `FAILED` | yes | Run cannot be trusted (`RECON_IMBALANCE`) **or** released by the reconcile / an operator | 0 |
| `REFUSED` | yes | Whole-batch hard stop (identity, mapping, coverage, currency, bill-run guard, reject threshold) | 0 |

A non-terminal batch older than a few minutes, with no running Kestra
execution, is **stranded**. Only `RECEIVED` and `PROCESSING` may be set to
`FAILED` (section 5).

### Rated-row statuses (`udr_rated.status`)

`RATED` (live, unbilled) → `BILL_DRAFT` (a bill run claimed it) →
`BILL_APPROVED` (billed). `SUPERSEDED` rows were replaced by a later run of the
same file key. Rows are never deleted or edited by hand.

---

## 3. Rules to know before you reload anything

1. **A byte-identical file is always discarded.** prp drops a delivery whose
   `(file_key, file_checksum)` matches **any** earlier batch of that file key,
   whatever that batch's status (`DUPLICATE_BATCH`, `WARNING`; no batch row is
   created). Renaming the file is not enough: **the bytes must differ.** This is
   deliberate (`tests/rating/rm11-stranded-batch-recovery.integration.test.ts`
   header).
2. **Reissues use `_vN`.** A corrected or retried delivery is
   `rating-input-file-<stamp>_v2.udr`, `_v3`, and so on. The suffix is
   for people. The run number comes from the database (`max + 1`).
3. **A successful reissue supersedes the earlier run.** When run N loads, every
   **live** row of the same `file_key` from earlier runs becomes `SUPERSEDED`,
   in all partitions, in the same transaction. It is matched by file key, never by source filename.
4. **Billed or in-flight data cannot be replaced.** If any earlier live row for
   the same natural key is `BILL_DRAFT` or `BILL_APPROVED`, rl **refuses** the
   whole batch:
   - `LOAD_BLOCKED_INFLIGHT` (`MINOR`, a draft bill run holds the rows):
     release the claim **before the run is approved**. Reject the affected
     accounts (a `PROCESSED` run, `PROCESSED` accounts only) or cancel the run
     (a stalled `PROCESSING` run only); both return the rows to `RATED`.
     Reload, then rerun or trigger again so the run collects the new rows. A
     rerun alone releases the rows but claims them again at once, so it
     leaves no room to reload. Do not wait for the run: once it is approved,
     the rows are `BILL_APPROVED` and the reload is refused as
     `LOAD_BLOCKED_BILLED`.
   - **An account that failed after its rows were claimed**
     (`PROCESSING_FAILED`, rows still `BILL_DRAFT`): reject and cancel do not
     apply to it. Approving the run marks it `SKIPPED` and releases **its**
     rows to `RATED` (since 2026-10-18, billing known-issues §27). What you
     can do next depends on the file:
     - **The usage data is correct** (the failure was billing-side: price,
       config, a guard): do not reload. Fix the cause. The released rows stay
       `RATED`, but a bill run only collects usage dated inside its own
       period, and the approved run for that period is closed, so **no run
       bills them**. The next run of that account lists them on its
       Exceptions tab as **Earlier period** (per month, with the record count
       and value) and counts them on the approval checklist ("Unbilled usage
       from earlier periods"). Revenue Ops handles them manually, by
       adjustment, and clears them before the account's next run (billing
       known-issues §28). The same applies to usage that is rated after its
       period's run was approved.
     - **The data must change, and the file holds only that account's rows:**
       reload the whole file as the next `_vN` (section 7). Nothing in it is
       billed, so the guard lets it through. The reloaded rows are still
       dated in the closed period, so **no run bills them either**: they
       appear as **Earlier period** on the next run, and Revenue Ops bills
       the corrected usage by adjustment, as in the case above.
     - **The data must change, and the file also holds other accounts' rows
       that were approved** (`BILL_APPROVED`): a reload of that file is
       refused as `LOAD_BLOCKED_BILLED`, because the guard checks every key
       in the file and supersession works per file key. There is **no
       rating-side partial reload**. Do not deliver the failed account's rows
       under a new file name either: the old rows stay live and the load
       aborts on the live-row constraint. The released rows stay `RATED` and
       no run bills them, so Revenue Ops bills the **full corrected** usage by
       adjustment (not only the difference), using the released rows as the
       starting point.
     - Check which case you are in with the section 7 step 1 query (any
       `BILL_APPROVED` row in the file key means the last case).
   - `LOAD_BLOCKED_BILLED` (`MAJOR`, already billed): the data is financially
     final. Rating cannot correct it. Correct it in billing (adjustment or credit
     note) instead.
5. **A reissue with fewer records** than the run it replaces raises
   `SHRINKING_REISSUE` (`MAJOR`). Rows missing from the new file are no longer live.
6. **The trigger remembers files it has seen.** It keeps state in the KV key
   `rating_rating-engine-ran-usage_landing-file` (namespace `rating`). A file
   it has already seen is not picked up again. The state may be keyed by the
   file's identity on disk, not only its name (section 10), so always deliver a
   reissue as a **new file** (`_vN`), never by renaming one in place.
7. **Keep `landing/` clean (known limitation).** The trigger is set to
   `maxFiles: 1`, and Kestra trims the folder listing to one file **before** it
   skips files it has seen. A failed file left in `landing/` can therefore hide
   every newer file (log: `Too many files to process (2), limiting to 1`). Move
   failed or superseded files to `error/` before you deliver the next one.
   This is the agreed operational process (owner decision, 2026-10-18); a
   per-file `ForEach` in the flow is not planned.
8. **Never delete `udr_batch` rows or edit `udr_rated`.** Batches are the audit
   trail of what was delivered; rows change state only through the flow.

---

## 4. Diagnose first

```sql
-- Batches for one file key, newest first
SELECT batch_id, source_file, batch_run_num, status,
       parsed_count, rated_count, rejected_count, discarded_count, superseded_count,
       COALESCE(started_at, received_at) AS since, completed_at,
       workflow_execution_id, error_summary
  FROM rating.udr_batch
 WHERE file_key = 'rating-input-file-202609010000'
 ORDER BY batch_run_num DESC;

-- What the run reported
SELECT log_datetime, event_code, log_level, component, specific_problem, additional_info
  FROM rating.process_log
 WHERE batch_id = 'UDRBAT00000003'
 ORDER BY log_datetime;

-- Rows actually loaded by a batch, by status
SELECT status, count(*) FROM rating.udr_rated
 WHERE udr_ref_batch_id = 'UDRBAT00000003' GROUP BY status;
```

Then open the execution named in `workflow_execution_id` in the Kestra UI
(**Executions → the id → Logs**) to see which task failed (`prp`, `rp` or `rl`)
and its error. Fix the cause before reloading (section 9 lists common causes).
Reloading a file with an unfixed cause fails the same way.

---

## 5. Mark a stuck batch `FAILED`

Marking a stranded batch `FAILED` **releases** it. The batch is closed in the
audit trail and the next delivery of that file key reprocesses cleanly. It is
always safe for a stranded batch, because a non-terminal batch never has
committed rows (rl loads in one transaction).

**Before any option below, confirm the run is really dead.** Open its
`workflow_execution_id` in Kestra. If the execution is still `RUNNING`, wait for
it, or **Kill** it in the Kestra UI (rl then rolls back). Never fail a batch
whose execution is still running.

### Option A — wait for the scheduled reconcile (default)

The `rating.rating-batch-reconcile` flow runs **every 5 minutes** and when Kestra
starts. It fails every `RECEIVED` / `PROCESSING` batch older than the threshold
in KV key `rating_stranded_batch_threshold_seconds` (namespace `rating`,
default **3600** seconds when unset). It records
`error_summary = 'BATCH_STRANDED: resolved by the stranded-batch reconcile'` and
raises a `BATCH_STRANDED` (`MAJOR`) alarm. The next `BATCH_COMPLETE` for the same
file key clears the alarm automatically.

Use this when nothing is urgent.

### Option B — run the reconcile now

This is the same module, with a short threshold. **It affects every stranded
batch older than the threshold, not just one.** Run the diagnosis query without
the `file_key` filter first, and make sure every non-terminal batch it lists
should be failed.

```sql
SELECT batch_id, file_key, status, COALESCE(started_at, received_at) AS since
  FROM rating.udr_batch WHERE status IN ('RECEIVED', 'PROCESSING') ORDER BY since;
```

```bash
docker exec -w /app enterprise-billing-app-workflow-engine-1 \
  /app/.venv/bin/python3 -m runtime.stranded_reconcile \
  --threshold-seconds 60 \
  --workflow-execution-id manual-<ticket-or-initials>-<yyyymmdd>
```

(PowerShell: the same command on one line.) Expected output:

```
BATCH_STRANDED: batch UDRBAT00000003 (file_key=…, run=3) resolved FAILED — claim released for reprocessing.
stranded-batch reconcile: 1 batch(es) resolved.
```

It emits the same `BATCH_STRANDED` alarm as Option A. **Prefer B over C**
whenever the target is the only strand.

### Option C — fail one specific batch by hand

Use this only when other strands must **not** be touched, for example a large
batch that is genuinely still parsing next to the dead one. It changes exactly
one batch, and only while that batch is still non-terminal.

> **Limitation:** unlike the reconcile, this does **not** write a
> `BATCH_STRANDED` line to `rating.process_log`, so no alarm is raised or later
> cleared. The `error_summary` text is the only record. Note the action in
> your incident or change ticket.

Run as an admin role (locally `postgres`). On Azure the runtime role
`rating_runtime` also holds the needed column grants, but use a named admin
login so the change is attributable.

```sql
\set batch 'UDRBAT00000003'
\set reason 'MANUAL_FAIL: rl crashed on period check; fix deployed (ops ticket OPS-123, <your name>)'

BEGIN;

-- 1. Lock and inspect. Must be RECEIVED or PROCESSING.
SELECT batch_id, file_key, batch_run_num, status,
       COALESCE(started_at, received_at) AS since, workflow_execution_id
  FROM rating.udr_batch WHERE batch_id = :'batch' FOR UPDATE;

-- 2. Must be 0. A non-terminal batch never has committed rows.
--    If this is not 0, STOP: ROLLBACK and escalate.
SELECT count(*) AS loaded_rows FROM rating.udr_rated WHERE udr_ref_batch_id = :'batch';

-- 3. Fail it. The status guard makes this a no-op on a terminal batch.
UPDATE rating.udr_batch
   SET status = 'FAILED', error_summary = :'reason', completed_at = now()
 WHERE batch_id = :'batch' AND status IN ('RECEIVED', 'PROCESSING')
RETURNING batch_id, status;

-- 4. COMMIT only if step 3 returned exactly one row and step 2 returned 0.
--    Otherwise ROLLBACK.
COMMIT;
```

### Never fail a terminal batch

Do **not** set a `COMPLETE` or `PARTIAL` batch to `FAILED`. Its rows stay live,
so the batch record would no longer match the data. To replace the data a
completed batch loaded, **reissue** the file (section 7). Supersession retires
the old rows correctly. `REFUSED` and `FAILED` batches are already terminal and
need nothing.

---

## 6. Reload a file after a failed, refused or partial run

1. **Fix the cause** (section 9). Check it with the diagnosis queries.
2. **Make sure no batch for the file key is still non-terminal.** If one is,
   release it (section 5). A changed file can technically be claimed while an
   old strand exists (`batch_run_num` is `max + 1`), but the strand then stays
   open and keeps alarming. Release it first.
3. **Clear `landing/`.** Move the failed delivery to `error/` (rule 7). It is
   still in `landing/` because only a successful load archives a file.
4. **Deliver a reissue with different bytes**, named `…_vN.udr` with the next
   free N:
   - **Corrected data:** the corrected file already differs. Just name it `_vN`.
   - **Same data, retried** (the cause was configuration, not the file): change
     the bytes without changing the content. Re-order the data rows and keep the
     header first. Row order does not affect rating. Bash example:

     ```bash
     SRC=workflow-management/dev/error/rating-input-file-202609010000.udr
     DST=workflow-management/dev/landing/rating-input-file-202609010000_v5.udr
     { head -1 "$SRC"; tail -n +2 "$SRC" | LC_ALL=C sort -t, -k4,4 -k3,3; } > "$DST.tmp" \
       && mv "$DST.tmp" "$DST"
     ```

     Check that the checksum is new before dropping it:
     `sha256sum "$DST"` against
     `SELECT file_checksum FROM rating.udr_batch WHERE file_key = '…';`.
     Build the file elsewhere and **move** it into `landing/` in one step, so the
     trigger never sees a half-written file.
5. **Watch it.** Within about a minute an execution appears in Kestra. The new
   batch should end `COMPLETE` (or `PARTIAL` with the rejects you expect), and
   the file moves to `archive/`.
6. **Earlier runs:** a `PARTIAL` earlier run that loaded rows has them
   `SUPERSEDED` by the new run: the old batch shows `superseded_by_batch_id`
   (and `supersede_reason`), and the new batch's `superseded_count` is the
   number of rows it retired. `FAILED` and `REFUSED` runs loaded nothing.

---

## 7. Replace data that already rated (reissue)

Use this when a `COMPLETE` or `PARTIAL` file must be corrected, for example
when upstream resends fixed usage.

1. **Check that no bill run holds the rows** (rule 4):

   ```sql
   SELECT r.status, r.billrun_ref_id, count(*)
     FROM rating.udr_rated r JOIN rating.udr_batch b ON b.batch_id = r.udr_ref_batch_id
    WHERE b.file_key = 'rating-input-file-202609010000' AND r.is_live
    GROUP BY 1, 2;
   ```

   - All `RATED`: safe to reissue.
   - Any `BILL_DRAFT`: release the claim first (reject the accounts or cancel
     the run, rule 4), or the load is refused with `LOAD_BLOCKED_INFLIGHT`.
   - Any `BILL_APPROVED`: stop. Rating cannot change billed data. Correct it in
     billing.
2. **Deliver the corrected file** as `…_vN.udr` (step 4 of section 6).
3. **Verify** that the new batch is `COMPLETE`, the old batch shows
   `superseded_by_batch_id` = the new batch, and live rows come only from the new
   batch. Look out for `SHRINKING_REISSUE` (fewer records than before) and
   `CROSS_PERIOD_SUPERSEDE` (a corrected timestamp moved a row to another
   month). Both are expected only if the correction meant to do that.

---

## 8. The trigger is not picking up a file

Work down this list:

1. **Name:** it must match `rating-input-file-\d{12}(_v\d+)?\.udr` exactly.
   Other files (e.g. `.csv`) are ignored by design.
2. **Another file in `landing/`:** see rule 7. Move older or failed files to
   `error/`.
3. **Already seen:** the same name was delivered before. Deliver it as the next
   `_vN` instead. As a last resort, reset the trigger state:
   - Kestra UI: **Namespaces → rating → KV Store** → delete
     `rating_rating-engine-ran-usage_landing-file`;
   - or

     ```bash
     docker exec enterprise-billing-app-workflow-engine-1 sh -c 'curl -s -X DELETE \
       -u "$KESTRA_SERVER_BASIC_AUTH_USERNAME:$KESTRA_SERVER_BASIC_AUTH_PASSWORD" \
       http://localhost:8080/api/v1/main/namespaces/rating/kv/rating_rating-engine-ran-usage_landing-file'
     ```

   After a reset, **every** file still in `landing/` counts as new on the next
   poll, so clear `landing/` first. A reset does not get past the byte-identical
   rule (rule 1). prp still discards a duplicate.
4. **Trigger errors:** in the Kestra logs for trigger `landing-file`, an
   `allowed-paths` error means `kestra.yml` lacks the
   `io.kestra.plugin.fs.local.Trigger` entry for `/data/landing`.

---

## 9. Common causes

| Event / symptom | Typical cause | Fix |
|---|---|---|
| `DUPLICATE_BATCH`, no new batch | Byte-identical redelivery | Section 6 step 4: change the bytes |
| prp: `subscription_product_name … resolves to no ACTIVE product_offering` (no batch) | The flow's `subscription_product_name` matches no ACTIVE offering name | Align the offering name or the flow variable |
| `UNKNOWN_SUBSCRIBER` (`REFUSED`) | No ACTIVE subscription with `udrType = RAN_USAGE` covers the usage date, or the customer's `mnoPublicKey1` does not match the feed's `mno_public_id` | Check subscription start/end dates against the usage dates, and the customer MNO key |
| `INPUT_UNMAPPED` (`REFUSED`) | A usage row has no ACTIVE rate-card cell (MNO + commercial unit + polygon), or the offering lacks `productCardLookUp` | Upload/activate the rate card; set the spec to the card name exactly |
| `RATECARD_COVERAGE_GAP` (`REFUSED`) | An ACTIVE rate-card cell has no usage in the file (`HARD_STOP`) | Correct the file or rate card, or switch the flow to `WARN` if gaps are acceptable |
| `SUBSCRIBER_REF_MISMATCH` / `SERVICE_CODE_MISMATCH` / `PRODUCT_PIN_MISMATCH` (`REFUSED`) | The rate card disagrees with the resolved customer, service code or pinned product family | Correct the rate card or product data |
| `LOOKUP_MISS` (`PARTIAL`, rows discarded) | No `usage_rate` price in effect on the usage date (e.g. the price starts after the usage month) | Make the price effective for the usage period, then reissue |
| `CURRENCY_MISMATCH` (`REFUSED`) | Price currency ≠ billing account currency | Correct the price or the account |
| `LOAD_BLOCKED_INFLIGHT` / `LOAD_BLOCKED_BILLED` (`REFUSED`) | A bill run holds the earlier rows | Section 7 step 1 |
| rl `CheckViolation … udr_rated_period_matches_check` (batch stuck `PROCESSING`) | rl computed the billing month in the wrong time zone (fixed 2026-10-18: rl now uses the `Asia/Kuala_Lumpur` month) | Rebuild the engine image if it is older, release the batch, reissue |
| Task error `Unable to find … used in the expression` | Flow and runtime image out of step (output names) | Redeploy the flows **and** rebuild the engine image from the same commit |

---

## 10. Known limitations (tracked, not fixed)

Found by the bm73 code review (2026-10-18). Each is handled as an operating
rule for now; the owner chose to track them rather than change the rating flow
or the Azure engine.

1. **Azure: the landing trigger is not configured.** `kestra.yml` (with the
   `allowed-paths` entries for `/data/landing` and `/distribution`) is loaded
   only by the local compose engine. The Azure Container App engine is
   configured by environment variables and never reads it, so on Azure every
   landing poll fails "The 'allowed-paths' configuration is required" and no
   usage is rated. **Before rating on Azure**, the infra work must give the
   engine this plugin configuration (net-new infra config; see
   `infra/bicep/modules/workflow-engine-container-app.bicep`).
2. **A misnamed file is ignored silently.** The trigger's `regExp` repeats
   `vars.file_key_rule`, so a file that does not match exactly (`.UDR`, `_V2`,
   a 14-digit stamp) never starts an execution: no batch row, no
   `FILE_KEY_UNRESOLVED`, no alarm. Upstream must deliver exact names; if
   usage seems missing, list `landing/` for files the trigger ignored. If
   `file_key_rule` changes, change `regExp` with it.
3. **A file seen half-written is not picked up again.** The trigger fires on
   `CREATE` only. If a poll sees a file while it is still being written, prp
   reads a torn file (`PARSE_FAILURE`, `REFUSED`), and the later "file
   finished" change is an update the trigger skips. Always build the file
   elsewhere and **move** it into `landing/` in one step (section 6 step 4).
   On some filesystems a new file can also reuse the disk identity of a file
   rl archived earlier and be treated as seen: if a correctly named, new file
   is never picked up, deliver it again as the next `_vN`.
