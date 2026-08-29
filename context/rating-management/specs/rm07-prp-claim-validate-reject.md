# rm07 — PRP: claim, validate, reject — Spec

- **Unit:** rm07 of rm01–rm13 (`specs/rm00-build-plan.md`, Phase D)
- **Repo:** rating repo · **Boundary:** `flows/**` — the `prp` section (replaces the rm06 stub)
- **Builds:** file pickup from `landing/`, database-backed claiming from the **filename**, checksum/`DUPLICATE_BATCH`, CSV parse + map to `udr_rated` key fields, the canonical `udr_key`, record-level validation with a reject file, the per-`udr_type` threshold, and the batch counts.
- **Depends on:** rm01 (`udr_batch`, constraints), rm06 (template + logging + sweep), rm04 (`landing/`, `error/`, the worker image with `polars`/`psycopg`/`hashlib`).
- **Config introduced:** the **feed profile** per `udr_type` — column mapping + the `udr_key` column list (**flow variable**, output-affecting: it defines identity); `file_key` derivation rule per `udr_type` (**flow variable**); reject threshold per `udr_type` (**flow variable**); chunk size per `udr_type` (**KV store**) — per `rm00` §Configuration.
- **Sources:** `rm00-build-plan.md` Unit rm07 + **Open item 1** · `rm01-rating-schema-foundation.md` D12 (`file_key`), D5 (timestamp precision), §4.2 (canonicalisation rule) · `ratemgmt-code-standards.md` §5.12 (file claim), §7 (logging), Inv #7, #10, #11 · `ratemgmt-project-overview.md` core flow steps 2–4.

> **Resolves Open item 1 — as a config-driven feed profile.** The `RAN_USAGE` feed is a **header CSV**: `DATETIME,PUBLIC_KEY,COMMERCIAL_UNIT,SITE,USAGE_MBPS`, and it is **a sample, not a fixed contract** — the feed→schema mapping and the `udr_key` column list are **per-`udr_type` configuration** (a *feed profile*), so a new feed adds a profile, not code. For the `RAN_USAGE` sample the profile composes `udr_key` from `{PUBLIC_KEY, COMMERCIAL_UNIT, SITE}` (D2). The **canonicalisation rule** is fixed (rm01 §4.2); the column list is the configured part. The engine treats the key columns as **opaque dimensions** — it does not hardcode their business meaning (`COMMERCIAL_UNIT` is **not** `udr_subscription_rateplan_ref`, and none of the three is assumed to be the subscriber).

---

## Goal

Replace the `prp` stub with the real Pre-Rating Processor for the `RAN_USAGE` CSV feed: **claim the file in the database from its filename before parsing**, discard a byte-identical redelivery, parse and map the CSV to `udr_rated` key fields, compute the canonical `udr_key` from `PUBLIC_KEY`/`COMMERCIAL_UNIT`/`SITE`, quarantine invalid records to a reject file with reason codes against the per-`udr_type` threshold, and stamp the batch counts — so a 50,000-record file claims itself, rejects the bad rows, and carries the good ones forward to RP.

---

## Design

### D1. The feed profile — a per-`udr_type` config, not hardcoded columns

A feed is described by a **profile** (per `udr_type`), so the design flexes to any feed by **adding a profile, not editing code**. A profile declares three structural roles plus the `udr_key` column list; the `RAN_USAGE` sample instantiates them:

| Profile role | `RAN_USAGE` sample | → `udr_rated` | Notes |
| --- | --- | --- | --- |
| **Event time** | `DATETIME` | `start_datetime` (`timestamptz`, **full precision**, rm01 D5) | Also derives `partition_period = rating.period_of(DATETIME)` (UTC, rm01 D3). `end_datetime = start_datetime` for a **point sample** (satisfies `end >= start`); if a fixed measurement interval per `udr_type` is configured, `end = start + interval`. |
| **Usage quantity + unit** | `USAGE_MBPS` → quantity, unit `'MBPS'` | `udr_usage_quantity` (`numeric(20,6)`), `udr_usage_unit` | The measured value, **never** part of identity. `FLAT` ignores it in v1; stored for audit and the non-`FLAT` types later. |
| **`udr_key` columns** (the configured key-dimension list) | `PUBLIC_KEY`, `COMMERCIAL_UNIT`, `SITE` | composed into `udr_key` (D2) | **Opaque key dimensions.** The engine does **not** map them to typed business columns — `COMMERCIAL_UNIT` is *not* `udr_subscription_rateplan_ref`, `SITE` gets no first-class column, and none is assumed to be the subscriber. Any mapping of a key column to a typed reference (e.g. a subscriber ref for resolution) is an **optional profile field**, declared only where a feed genuinely has that semantic — not asserted for this sample. `udr_resource` stays NULL (Inv #16a). |

Everything else on `udr_rated` (rating output, price provenance, the bill-run columns) is populated **downstream** by RP/RL, not from the feed.

### D2. The `udr_key` column list — configured, not fixed (Open item 1, resolved)

**`udr_key` = canonical serialisation of the profile's configured key columns.** For `RAN_USAGE` that is `{PUBLIC_KEY, COMMERCIAL_UNIT, SITE}`, so the natural key is `(start_datetime, canon(PUBLIC_KEY, COMMERCIAL_UNIT, SITE))`. A different feed lists different columns in its profile; the mechanism is unchanged — **that flexibility is the point**.

- **The measured value is always excluded.** `USAGE_MBPS` is not identity — including it would let two readings of the *same* event with different measured values both go live: a double count (the same reasoning that excludes `batch_run_num`, rm01 D11).
- **The canonicalisation rule is fixed (rm01 §4.2)** and applies to whatever columns the profile lists: sort the key names, trim and case-normalise values, UTC for any timestamp component, join as `k=v` pairs with a fixed separator — e.g. `COMMERCIAL_UNIT=<v>|PUBLIC_KEY=<v>|SITE=<v>`. Two logically identical records serialised differently must produce the **same** `udr_key`. The rule is fixed; only the **column list** is configured, and it must include whatever distinguishes a delivery's records (rm01 D12's distinguishing-key requirement).
- The 512-char cap (rm01 `CHECK`) is untouched.

### D3. `file_key` from the **filename**, never the content

The claim precedes parsing, so `file_key` is derived from the **filename** by a rule predefined per `udr_type` (rm01 D12, Inv #5). **Assumed convention (confirm with upstream):** `RAN_USAGE_<YYYYMMDD>[_vN].csv` → `file_key = RAN_USAGE_<YYYYMMDD>`, so `RAN_USAGE_20260814.csv` and `RAN_USAGE_20260814_v2.csv` resolve to one delivery. The **rule is a flow variable per `udr_type`**. A name the rule cannot parse (`corrected.csv`) refuses the file with **`FILE_KEY_UNRESOLVED`** at `MAJOR` — never a fall-back to "treat as new" (rm01 D12). The CSV header defines *content*; `file_key` needs the *name* — this is a naming contract with the file provider.

### D4. Claim before parse (Inv #7)

PRP's first actions, in order (rm01 D12):
1. **Derive `file_key`** from the filename; refuse with `FILE_KEY_UNRESOLVED` if it does not resolve.
2. **Compute the file checksum** (`hashlib`); if a prior batch for this `file_key` has the identical checksum, discard as **`DUPLICATE_BATCH`** before any parsing cost (D5).
3. **Insert the `udr_batch` claim** with `status = RECEIVED`, `batch_run_num = COALESCE(max,0)+1` within `file_key`, the checksum and size — inside the insert, so `UNIQUE (file_key, batch_run_num)` decides ownership. A file that dies during parse still leaves this row.

### D5. Byte-identical redelivery → `DUPLICATE_BATCH`

Checksum compared within the same `file_key`; an identical redelivery is discarded before parsing (`WARNING`, `DUPLICATE_BATCH`). A *changed* file under the same `file_key` is a genuine reissue → a new `batch_run_num` (superseded later by rm10).

### D6. Record-level quarantine, reject file, threshold

Valid rows carry forward; invalid rows go to a reject file (rm00 §3.1). Validation categories for this feed:

| Reason code | Trigger |
| --- | --- |
| `MALFORMED_ROW` | wrong column count, unquotable/garbled row |
| `BAD_DATETIME` | `DATETIME` unparseable or not a valid instant |
| `BAD_USAGE` | `USAGE_MBPS` non-numeric, negative, empty, or **not representable in the `udr_usage_quantity` `numeric(20,6)` target** (more than 6 *significant* fractional digits, or a 15+-digit integer part) — PRP fails closed here rather than let RP silently round or overflow the measured quantity (§5.4/D8). Trailing zeros are not significance (`42.5000000` is accepted). |
| `MISSING_KEY_FIELD` | empty `PUBLIC_KEY`, `COMMERCIAL_UNIT`, or `SITE` (a NULL key dimension cannot dedup) |
| `UNKNOWN_SUBSCRIBER` | *(only when the profile maps a key column to a subscriber ref)* that reference does not resolve in `inventory.product_inventory` |
| `OUT_OF_RANGE` | `DATETIME` in the future beyond a tolerance |
| `DUPLICATE_IN_FILE` | two rows share `(start_datetime, udr_key)` within this file |
| `DUPLICATE_LIVE` | the natural key already has a live row (reissue handled by rm10, not here) |

Rejects are written to a **reject file in `error/`** with the original row, its line number, and reason code(s). The **per-`udr_type` reject threshold** (flow variable; `0` = file-level all-or-nothing): below it → the batch reaches `PARTIAL` and carries the survivors; above it → the whole file is refused. `parsed_count`, `rejected_count`, `discarded_count` are stamped on the batch (`rated_count` is rm09's).

### D7. Chunked, never per-record (Inv #10)

PRP reads and processes the CSV in **chunks** (`polars` streaming / batched reads), sized by the per-`udr_type` **chunk-size KV config**, and hands each chunk to RP as a **Parquet file URI** (typed — preserves `Decimal` and the UTC `start_datetime`). No task fans out per record; the OSS JDBC queue would degrade (code-standards §3.2).

### D8. Computation lives in Python, with the money/UTC rules

`udr_key` canonicalisation, checksum, parsing and validation run in the worker image's Python (rm04 D3): `USAGE_MBPS` parsed as **`Decimal`, never `float`**; `DATETIME` normalised to **UTC**; the file checksum via **`hashlib`**. Reject writing and the summarised log line use the rm06 contract.

### D9. Log proportionality (Inv #11)

Per-record rejects go to the **reject file**, never one `process_log` row each. The batch emits **one** summarised `BATCH_PARTIAL` (or the refuse case's row) with the counts and a pointer to the reject file (rm06; code-standards §7.4).

---

## Implementation

### 1. The `prp` flow section (replaces the rm06 stub)

Replace the `# STUB: rm07` section of `flows/ran-usage-rating.yaml` with a Python `Commands`/`Script` task calling `prp.py` from the worker image. The `landing/` **file trigger** is added here (rm06 used a manual trigger): `io.kestra.plugin.core.trigger` on the `landing/` mount, `concurrency: limit: 1` per `udr_type` retained.

### 2. `file_key` derivation + the claim (`prp.py`)

Read the `file_key` rule (flow variable) for the `udr_type`, apply it to the filename, refuse `FILE_KEY_UNRESOLVED` on no match. Then the claim insert (rm01 D12):

```sql
INSERT INTO rating.udr_batch (file_key, source_file, file_key_rule, udr_type,
                              batch_run_num, file_checksum, file_size_bytes, status)
SELECT $file_key, $source_file, $rule, $udr_type,
       COALESCE(max(batch_run_num),0)+1, $checksum, $size, 'RECEIVED'
  FROM rating.udr_batch WHERE file_key = $file_key;
```

`UNIQUE (file_key, batch_run_num)` makes two concurrent workers computing the same `max+1` safe — one loses.

### 3. CSV parse + mapping + `udr_key` (`prp.py`)

`polars.read_csv` (streaming, chunked) with the fixed header; map columns per D1; compute `udr_key` per D2 (sorted keys, trimmed, fixed separator); parse `DATETIME`→UTC; `USAGE_MBPS`→`Decimal`. Emit each chunk as a Parquet file URI for RP.

### 4. Validation + reject writer (`prp.py`)

Apply the D6 checks per row; write rejects to `error/<file_key>-run<N>-rejects.csv` with `line_no`, `reason_code`, and the raw row; count `parsed`/`rejected`/`discarded`. `UNKNOWN_SUBSCRIBER` runs **only when the profile declares a subscriber-ref mapping**, and then checks `inventory.product_inventory` (rm03 grants `SELECT`).

### 5. Threshold + `PARTIAL`/refuse (`prp.py`)

Read the reject-threshold flow variable; if `rejected_count / parsed_count` exceeds it (or any reject when threshold `= 0`), set `udr_batch.status` toward refuse and stop; else stamp counts and set the batch to carry survivors, ending `PARTIAL` at RL.

### 6. Config introduced

- `file_key` rule per `udr_type` → **flow variable** (changes which records get grouped/superseded).
- reject threshold per `udr_type` → **flow variable** (changes which records get billed at all).
- chunk size per `udr_type` → **namespace KV store** (performance only).

(Per `rm00` §Configuration; output-affecting values live in flow `variables`.)

---

## Dependencies (packages to install)

**None new.** `polars` (streaming CSV + chunking), `pyarrow` (Parquet handoff), `psycopg` (claim + `inventory` lookup), and stdlib `hashlib`/`decimal`/`datetime` are all in the rm04 worker image. No npm packages.

---

## Verification checklist

Live database + a running engine (real or local, rm04). The headline case is the `RAN_USAGE` 50,000-record fixture with 37 bad rows.

**Claim and dedup (Inv #7, test #9)**

1. A 50,000-record file with 37 bad records **claims itself** (a `udr_batch` `RECEIVED` row appears before parsing), writes a reject file naming the 37 with reason codes, carries 49,963 forward, and reaches `PARTIAL`.
2. A **second concurrent** attempt on the same file fails on `UNIQUE (file_key, batch_run_num)` — exactly one batch.
3. A **byte-identical redelivery** is discarded as `DUPLICATE_BATCH` before parsing.
4. `file_key` is derived from the **filename**; `RAN_USAGE_20260814.csv` and `RAN_USAGE_20260814_v2.csv` derive the **same** `file_key`; two different content dates never derive the same key; an unparseable name refuses with `FILE_KEY_UNRESOLVED`.

**Key correctness (D1, D2)**

5. `udr_key = canon(PUBLIC_KEY, COMMERCIAL_UNIT, SITE)`; two rows differing **only** in `USAGE_MBPS` collide on the natural key — proving usage is excluded from identity.
6. `DATETIME` maps to `start_datetime` at full precision; `partition_period = rating.period_of(DATETIME)` files the row in the **UTC** month.
7. Two rows with the same key dimensions serialised differently (case/whitespace) produce the **same** `udr_key`.

**Validation and rejects (D6, Inv #11)**

8. Each of `MALFORMED_ROW`, `BAD_DATETIME`, `BAD_USAGE`, `MISSING_KEY_FIELD`, `OUT_OF_RANGE`, `DUPLICATE_IN_FILE` lands in the reject file with the correct reason code. `UNKNOWN_SUBSCRIBER` applies **only when the profile declares a subscriber-ref mapping** (D6) — it is asserted against such a profile, not the `RAN_USAGE` sample (which declares none, so the code never fires there); `RAN_USAGE` behaviour is unchanged.
9. Per-record rejects go to the **reject file**; the batch emits **one** summarised `BATCH_PARTIAL` row, independent of reject count (test #12).
10. With threshold `= 0`, the first bad record refuses the whole file; below threshold, the file reaches `PARTIAL`.

**Volume and hygiene (Inv #10)**

11. A 50,000-record file processes **without per-record fan-out** — task count bounded by chunk count (chunk-size KV config).
12. `parsed_count`, `rejected_count`, `discarded_count` are stamped on the batch.
13. `USAGE_MBPS` is handled as `Decimal` (a sub-decimal value survives), `DATETIME` as UTC; no `float` path; no `console.*`, no `TODO` (the `# STUB:` is now real code).
