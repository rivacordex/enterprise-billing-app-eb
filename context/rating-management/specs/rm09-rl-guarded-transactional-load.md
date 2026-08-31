# rm09 — RL: guarded transactional load — Spec

- **Unit:** rm09 of rm01–rm13 (`specs/rm00-build-plan.md`, Phase D)
- **Repo:** rating repo · **Boundary:** `flows/**` — the `rl` section (replaces the rm06 stub)
- **Builds:** the pre-load `BILL_APPROVED` guard, the `CURRENCY_MISMATCH` assertion, the one-transaction load at `RATED` (guard + supersede-hook + insert), reconciliation, and archive-after-commit.
- **Depends on:** rm01 (constraints), rm07 (the batch + counts), rm08 (rated rows with `udr_currency`).
- **Sources:** `rm00-build-plan.md` Unit rm09 · `ratemgmt-architecture.md` Inv #6, #8, #9, #3 · `ratemgmt-code-standards.md` §5.15 (currency), §3.6 (one transaction) · `_newmodule-rating-engine-plan.md` §6.3 (guard), §9.5 (no cross-task transaction), §9.7 (archive ordering) · rm04 D4 (cross-protocol archive), rm08 D9 (currency source).

> **Codebase-grounded:** the currency join is `product_inventory.billing_account_id → billing.billing_account.currency` (`char(3)`), confirmed in the rm08 investigation. The archive is a **cross-protocol copy** — `landing/` is Azure Files (SMB), `archive/` is Azure Blob (rm04 D4) — so archive-after-commit is copy-then-delete, not a rename.

---

## Goal

Replace the `rl` stub with the guarded transactional loader: in **one** psycopg transaction, refuse the whole batch on any live `BILL_APPROVED` collision, assert currency, run the supersede hook (rm10 fills it), bulk-insert the rated rows at `RATED`, reconcile the counts, and — **only after commit** — archive the raw file across the SMB→Blob boundary. A clean file reaches `COMPLETE` with the file in `archive/`; a colliding file writes **zero** rows; a mid-transaction failure leaves the file in `landing/` and nothing loaded.

---

## Design

### D1. One transaction, inside RL (Inv #8)

PRP → RP → RL are three processes with **no shared transaction** (§9.5); the transaction boundary is **RL**. The guard (D2), the supersede hook (D8), and the insert (D4) are **one psycopg transaction or none of them happened** — a single connection, `BEGIN … COMMIT`. Flow-level recovery is re-running the batch, safe because of Inv #3 and because superseding an already-superseded row is a no-op (D9).

### D2. The `BILL_APPROVED` guard — refuse the whole batch (Inv #6)

Inside the transaction, before inserting: for every incoming natural key, query for an existing **live** row with `status = 'BILL_APPROVED'`. If **any** is found → **refuse the whole batch**: write zero rows, set `udr_batch.status = REFUSED`, and emit `LOAD_BLOCKED_BILLED` at `MAJOR` with the colliding keys and their `billrun_ref_id` in `additional_info`, `managed_object` = the source file. Batch-level refusal is a **deliberate exception** to the record-level default: a collision with an approved invoice means the file's assumptions about the period are wrong — a human decision, not a per-record disposition. The check-then-insert race is closed by the transaction and backstopped by the live-row unique constraint (Inv #3).

### D3. The `CURRENCY_MISMATCH` assertion

RL asserts the resolved `udr_currency` (rm08, from the price row) equals `billing_account.currency`, joined via `product_inventory.billing_account_id`. Nothing in the schema constrains the two to agree, so the assertion is the **only** check (code-standards §5.15). A mismatch **refuses the batch** at `MAJOR` (`CURRENCY_MISMATCH`) — fail-closed, because billing in the wrong currency is worse than refusing a file whose currency configuration is wrong.

### D4. Bulk insert at `RATED` via `COPY` (Inv #10, #3)

Insert the rated rows at `status = RATED` using psycopg **`COPY`** — never row-by-row, which would not survive the volume. The live-row unique constraint `UNIQUE (partition_period, start_datetime, udr_key, is_live)` is the **final backstop**: a double-live insert aborts the transaction even if the guard or supersede logic is wrong, raced, or skipped (Inv #3). Application checks are a better error message, never the guarantee.

### D5. Reconciliation (Inv-adjacent, code-standards §10.10)

After the insert, stamp `rated_count` and assert **`parsed = rated + rejected + discarded`** (`parsed`/`rejected`/`discarded` from rm07, `rated` here). An imbalance is `RECON_IMBALANCE` at **`CRITICAL`** (integrity at risk) and the batch ends `FAILED` — a mismatch means rows went missing or doubled and the run cannot be trusted.

### D6. Archive-after-commit, cross-protocol (Inv #9, §9.7)

**Ordering rule: process → commit → archive. Never archive before the load commits.** Only after the transaction commits does the flow **copy** the raw file `landing/` (SMB) → `archive/` (Blob), **delete** it from `landing/`, and set `udr_batch.archive_file_path` (a **Blob URI**; `source_file` stays the SMB name — not comparable strings, rm04 D4). The copy-then-delete window (file in both, or neither) is **non-atomic across protocols**, so rm09 makes it **recoverable**: the archive step is idempotent, and a batch that **committed** but whose archive did not complete has `archive_file_path` NULL — a reconcile **re-attempts the archive only**, never re-loads (the rows are committed). A worker killed **before** commit leaves the file in `landing/`, the transaction rolled back, and a batch stranded at `PROCESSING` for rm11 to resolve.

### D7. Terminal status and events

| Outcome | `udr_batch.status` | Event |
| --- | --- | --- |
| Clean load, all records rated | `COMPLETE` | `BATCH_COMPLETE` (clears the `alarm_key`) |
| Some records rejected within threshold (rm07) | `PARTIAL` | `BATCH_PARTIAL` (`MINOR`) with counts + reject-file pointer |
| `BILL_APPROVED` collision | `REFUSED` | `LOAD_BLOCKED_BILLED` (`MAJOR`) |
| Currency mismatch | `REFUSED` | `CURRENCY_MISMATCH` (`MAJOR`) |
| Reconciliation imbalance | `FAILED` | `RECON_IMBALANCE` (`CRITICAL`) |

### D8. The supersede hook (a named point for rm10)

RL builds the transaction with a **named supersede-hook** — a `# STUB: rm10` immediately before the insert, inside the transaction. In rm09 (first load, `batch_run_num = 1`) there is nothing to supersede, so the hook is a **no-op stub**. rm10 fills it with batch-level supersession, in the **same** transaction. This keeps the transaction boundary owned by rm09 and supersession owned by rm10.

### D9. Recovery is re-running the batch

A retried RL re-attempts the whole load; safe because the `UNIQUE (file_key, batch_run_num)` claim (rm07) and the live-row constraint (Inv #3) make a double-load impossible, and superseding an already-superseded row is a no-op (§9.5).

---

## Implementation

### 1. The `rl` flow section (replaces the stub)

Replace the `# STUB: rm09` section of `flows/ran-usage-rating.yaml` with a Python `Commands`/`Script` task calling `rl.py`. One psycopg connection, one transaction.

### 2. The guard (`rl.py`, in the transaction)

```sql
SELECT ur.start_datetime, ur.udr_key, ur.billrun_ref_id
FROM   rating.udr_rated ur
JOIN   _incoming i ON i.start_datetime = ur.start_datetime AND i.udr_key = ur.udr_key
WHERE  ur.is_live AND ur.status = 'BILL_APPROVED';
-- any row → refuse the whole batch, LOAD_BLOCKED_BILLED, status REFUSED, zero rows.
```

### 3. `CURRENCY_MISMATCH` assertion (`rl.py`)

```sql
SELECT ba.currency
FROM   inventory.product_inventory pi
JOIN   billing.billing_account ba ON ba.billing_account_id = pi.billing_account_id
WHERE  pi.product_inventory_id = $subscriber_ref;
-- currency <> udr_currency → CURRENCY_MISMATCH (MAJOR), refuse the batch.
```

### 4. Supersede hook

`# STUB: rm10 — batch-level supersession by file_key, across all partitions, in THIS transaction.` No-op in rm09.

### 5. Insert at `RATED`

`COPY` the rated chunk(s) into `rating.udr_rated` at `status = 'RATED'`. The live-row constraint aborts any double-live.

### 6. Reconcile + terminal status

Stamp `rated_count`; assert `parsed = rated + rejected + discarded`; set the terminal status + emit the event per D7; commit.

### 7. Archive-after-commit (`rl.py`, after COMMIT)

Copy `landing/<file>` (SMB) → `archive/<blob>` (Blob, `azure-storage-blob`), verify, delete from `landing/`, set `archive_file_path`. Idempotent and retry-safe (D6).

---

## Dependencies (packages to install)

**None new.** `psycopg` (transaction + `COPY` + the guard/currency queries), `azure-storage-blob` (the archive copy), and stdlib `decimal` are in the rm04 worker image. No npm packages.

---

## Verification checklist

Live database + engine. Fixtures include a live `BILL_APPROVED` row and a currency-mismatched account.

**The guard (Inv #6, test #8)**

1. A batch containing any record colliding with a live `BILL_APPROVED` row writes **zero** rows, sets `udr_batch.status = REFUSED`, and raises `LOAD_BLOCKED_BILLED` naming the colliding keys and their `billrun_ref_id`.

**Transaction integrity (Inv #8, #3)**

2. The guard + supersede-hook + insert are **one transaction** — a deliberately-failing insert rolls back everything; no partial rows, no half-updated batch.
3. A test that deliberately **skips** the supersede hook aborts on the live-row unique constraint rather than double-loading (Inv #3 backstop).
4. The bulk insert uses `COPY` (no per-record inserts).

**Currency (D3)**

5. A resolved `udr_currency` that differs from `billing_account.currency` refuses the batch with `CURRENCY_MISMATCH` at `MAJOR`.

**Reconciliation (test #10)**

6. `parsed = rated + rejected + discarded` for a clean batch; a deliberate imbalance emits `RECON_IMBALANCE` at `CRITICAL` and the batch ends `FAILED`.

**Archive ordering (Inv #9, test #14)**

7. A clean file loads end to end, reaches `COMPLETE` with counts that reconcile, and the raw file is in `archive/` (a Blob URI in `archive_file_path`; `source_file` still the SMB name).
8. A simulated failure **mid-transaction** leaves the file in `landing/`, **zero** rows in `udr_rated`, and nothing archived.
9. A worker killed **after commit but before archive** leaves the rows loaded and the batch recoverable — the reconcile **re-attempts the archive only**, never re-loads.

**Hygiene**

10. No `console.*`; the supersede point is a `# STUB: rm10`; `Decimal` amounts, no `float`.
