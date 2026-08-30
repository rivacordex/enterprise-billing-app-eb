# rating-engine worker runtime

Reusable, **format-agnostic plumbing** the rating flow components
(`prp`/`rp`/`rl`, ratemgmt-code-standards §3.5) call from Kestra Python tasks.
This is foundation, not business logic.

| Module | Provides | Owning spec for the real logic |
| --- | --- | --- |
| `db.py` | psycopg connect as `rating_runtime`, `fetch` (as-of reads), `execute`, `transaction` (RL's one atomic unit, Inv #8), `copy_insert` (bulk, never per-record) | rm07/rm08/rm10 (column sets, rate math, supersession) |
| `storage.py` | file I/O over `landing/archive/error/logs`, polars readers for fixture/chunk formats, `move` | rm09 (archive move) |
| `prp.py` | **rm07's real Pre-Rating Processor** (`python3 -m runtime.prp`): `file_key` from the filename, `DUPLICATE_BATCH` checksum discard, the `UNIQUE (file_key, batch_run_num)` claim, config-driven feed profile + canonical `udr_key`, record-level validation → reject file, reject threshold (`PARTIAL`/refuse), chunked Parquet handoff | rm07 owns this; rm08 (RP) consumes its chunk manifest |
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
