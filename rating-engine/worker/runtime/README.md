# rating-engine worker runtime

Reusable, **format-agnostic plumbing** the rating flow components
(`prp`/`rp`/`rl`, ratemgmt-code-standards §3.5) call from Kestra Python tasks.
This is foundation, not business logic.

| Module | Provides | Owning spec for the real logic |
| --- | --- | --- |
| `db.py` | psycopg connect as `rating_runtime`, `fetch` (as-of reads), `execute`, `transaction` (RL's one atomic unit, Inv #8), `copy_insert` (bulk, never per-record) | rm07/rm08/rm10 (column sets, rate math, supersession) |
| `storage.py` | file I/O over `landing/archive/error/logs`, polars readers for fixture/chunk formats, `move`, and the archive backend `copy_to_archive`/`archive_exists`/`archive_uri` (**Azure Blob** via `azure-storage-blob` when `RATING_ARCHIVE_BLOB_URL` is set, else local `archive/`) | rm09 owns the archive ordering in `rl.py`; the backend lives here |
| `prp.py` | **rm07's real Pre-Rating Processor** (`python3 -m runtime.prp`): `file_key` from the filename, `DUPLICATE_BATCH` checksum discard, the `UNIQUE (file_key, batch_run_num)` claim, config-driven feed profile + canonical `udr_key`, record-level validation → reject file, reject threshold (`PARTIAL`/refuse), chunked Parquet handoff | rm07 owns this; rm08 (RP) consumes its chunk manifest |
| `rp.py` | **rm08's real Rating Processor** (`python3 -m runtime.rp`): consumes PRP's manifest, resolves the event-time price as-of `start_datetime` through the **pinned** `product_offering` version (one set-based as-of SQL query per chunk, `[start, end)`), applies any `order_item_price_override`, snapshots the resolved inputs, computes `FLAT` (raw `numeric(18,6)` + rounded `numeric(18,2)`, quantity ignored) in `Decimal`, stamps `udr_currency` + version columns, and hands off a rated Parquet manifest to RL. Writes nothing to `rating.*` — the insert is RL's | rm08 owns this; rm09/rm10 (RL) consume its rated manifest |
| `rl.py` | **rm09's real Rating Loader** (`python3 -m runtime.rl`): consumes RP's rated manifest and, in ONE psycopg transaction (Inv #8), runs the `BILL_APPROVED` guard (refuse whole batch → `LOAD_BLOCKED_BILLED`/`REFUSED`), the `CURRENCY_MISMATCH` assertion, the `# STUB: rm10` supersede-hook (no-op in rm09), the bulk `COPY` insert at `RATED`, and reconciliation (`parsed = rated + rejected + discarded`; imbalance → `RECON_IMBALANCE`/`FAILED`); then — **only after commit** — the idempotent cross-boundary `landing/` → `archive/` archive (copy-then-delete, `archive_file_path` set last) | rm09 owns the transaction boundary + archive; rm10 fills the supersede-hook |
| `transform.py` | polars `join` / `correlate` / `unmatched` (whole file or chunk, §3.2) | rm07+ (which correlations, reject policy) |
| `logemit.py` | JSON-Lines log lines matching the `process_log` contract (§7.9) | rm06 (the sweep that inserts them and resolves severity from `event_catalog`) |
| `log_sweep.py` | The independent sweep (idempotent by rename-on-completion, with a documented residual commit→rename window — see the module docstring) — parses `logs/`, resolves severity via the three-outcome `event_catalog` LEFT JOIN, rename-on-completion to `logs/swept/`, quarantines malformed lines to `logs/malformed/`, and isolates a poison file per run | rm06 owns this outright; nothing later replaces it |
| `emit_terminal_log.py` | The flow-level `errors`/`finally` terminal-outcome log line (§3.9) | rm06 owns the mechanism; rm07-rm12 may want real per-component failure event_codes as they replace the stubs — see its docstring |

## What this is NOT

- **Not rating logic.** Nothing here computes a rate, applies a discount, or
  decides a supersession — that would be in the wrong repository (§8.1). Each
  spot that will hold such logic carries a `# STUB:` naming the owning unit.
- **`storage.read_frame` is not the usage-feed parser.** It handles generic
  columnar/text formats for fixtures and intermediate chunks only. rm07's
  `prp.py` owns the real `RAN_USAGE` CSV parse (Python `csv` for raw-line +
  line-number reject fidelity, polars for the chunk Parquet write); Open item 1
  is resolved as a config-driven feed profile, so a new feed adds a profile, not
  a new parser.
- **Baked into the image as of rm06.** `../Dockerfile` now `COPY`s this
  package to `/app/runtime` with `PYTHONPATH=/app`, alongside the flows
  (`../../flows/`) that invoke `log_sweep`/`emit_terminal_log` via
  `python3 -m runtime.<module>`.

## Conventions enforced here

- Secrets are read from `SECRET_RATING_RUNTIME_PASSWORD` (Kestra's secret
  backend, §3.8) and never logged (§7.8).
- Money/rate columns stay `Decimal`/`str`, never `float` (§2.1, §5.9).
- Reads use an as-of SQL predicate, never pull-all-then-filter (§6.4).
- Writes stay inside `rating_runtime`'s grants (§9) — the database is the
  guarantee; an out-of-boundary write fails as a permission error (§1.3).
