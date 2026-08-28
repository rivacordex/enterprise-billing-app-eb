# rm06 — Flow template, logging contract and log sweep — Spec

- **Unit:** rm06 of rm01–rm13 (`specs/rm00-build-plan.md`, Phase C — the pipeline spine)
- **Repo:** rating repo · **Boundary:** `flows/**` (+ a flow-deploy stage in the rating-repo `azure-pipelines.yml`)
- **Builds:** the rating flow **template** (three named, ordered, **stubbed** `prp`/`rp`/`rl` sections), the JSON Lines logging contract, the independent idempotent **log-sweep** flow, and the git-based flow-deployment mechanism — no business logic.
- **Depends on:** rm01 (`process_log`), rm02 (`event_catalog`), rm04 (the engine, its mounts, the worker image with `psycopg`/`json`).
- **Sources:** `ratemgmt-code-standards.md` §3 (workflow-definition standards), §7 (logging & event standards), §10 test #16 · `rm00-build-plan.md` Unit rm06 + Open items **5** and **8** · `_newmodule-rating-engine-plan.md` §8 (X.733 logging), §9.5 (no cross-task transaction).

> **Scope, stated first (Open item 5 clarified):** rm06 delivers the flow **template** — structure, wiring, and `# STUB:` placeholder comments **only**. No rate maths, no parsing, no guards. Those replace the stubs section by section in rm07–rm12 (`ratemgmt-ai-workflow-rules.md` §2.5, §3.1). The **logging contract and the sweep are real** (logging is a contract other units depend on, not a stub). Testing uses a **basic dummy sample** (Open item 8).

---

## Goal

Ship the rating flow **template** — three named, ordered, stubbed `prp`/`rp`/`rl` sections with placeholder comments and no business logic — plus the **JSON Lines logging contract** and the independent, **idempotent** log-sweep that loads `logs/` into `rating.process_log` with severity resolved from the catalog, deployed from git by the pipeline (never the UI), and proven end to end on a dummy sample.

---

## Design

### D1. Templates only — no business logic (Open item 5)

Each of `prp`, `rp`, `rl` is a **named stub** carrying an explicit `# STUB:` comment that names its owning spec (rm07, rm08, rm09…). No parsing, no `file_key` derivation, no price resolution, no guards, no rate maths in rm06 — those replace the stubs **section by section** in rm07–rm12 (ai-workflow-rules §2.5). The deliverable is the **wired spine**: a file moves through three sections, each logs, and the sweep captures it. A `# STUB:` is a documented section, never a `TODO` (code-standards §1.5, §3.5).

### D2. Flows are deployed from git, never edited in the UI (closes Open item 5)

The **mechanism**: the rating-repo `azure-pipelines.yml` (rm04) gains a **flow-deploy stage** that, on merge to `main`, validates the flow YAML and pushes `flows/**` to the Kestra instance via the `kestra` CLI — `kestra flow namespace update rating ./flows` — authenticated with the Basic Auth credential from Key Vault. This satisfies code-standards §3.1 (version-controlled, deployed from the repository); the UI is **read-only in practice**. It is minimal because rm06 only carries templates, and it carries the real logic in rm07+ **unchanged**. *(Alternative: Kestra's `git.Sync` task; the CLI-in-pipeline route keeps deployment inside the existing DevOps gate rather than adding a runtime Git dependency.)*

### D3. Manual trigger only

rm06's flow runs on a **manual/API trigger**. The `landing/` file trigger is **rm07's** — building it here then rewriting it there is duplicated work (rm00 rm06). The manual trigger is enough to demonstrate the spine.

### D4. Three named, ordered sections — never merged, reordered, or inlined

`prp` → `rp` → `rl`, in that order (code-standards §3.5). Each carries its `# STUB:` marker, its **logging block**, and its named guards (as comments in rm06). The RL section's comment states the transaction boundary it will own (guard + supersede + insert in one transaction, Inv #8) so rm09 has a named home.

### D5. Task-to-task handoff by file URI, never record payload

Sections pass **file URIs** through Kestra internal storage (Blob, rm04), never record payloads — Kestra persists task `outputs` in its database and a large JSON output bloats the execution tables (code-standards §3.4). Even the template demonstrates the shape: a stub task emits a file URI, the next consumes it.

### D6. Flow-level `concurrency: limit: 1` per `udr_type`

Declared on the flow (code-standards §3.7). One of three concurrency layers (with the `UNIQUE (file_key, batch_run_num)` claim and the live-row constraint); not a substitute for either, and present from the template on.

### D7. Error **and** finally handlers write a terminal-outcome log line

There is no app endpoint to POST to (rating exposes no HTTP surface), and a crashed flow cannot insert its own crash — so both handlers write a **log line** that the sweep (D9) later loads. The `errors` handler fires only on failure; the `finally` block always runs, so a killed execution still reports (code-standards §3.9).

### D8. The JSON Lines log-line contract

One JSON object per line, UTF-8, newline-delimited — **not** pipe-delimited: `specific_problem` carries raw error text (exactly where pipes, quotes and newlines appear) and `additional_info` is `jsonb`, so a delimited format would embed JSON inside itself and corrupt on the first stack trace (code-standards §7.9). **Fields, mapping one-for-one onto `rating.process_log`:**

```
log_datetime, component, log_level, perceived_severity (nullable),
event_code, specific_problem, managed_object, alarm_key,
source_file, batch_id, workflow_execution_id, additional_info
```

**`partition_period` is NOT a log-line field.** It is `NOT NULL` on `process_log` with no default, so the **sweep** computes it as `rating.period_of(log_datetime)` at insert (rm03 grants the `EXECUTE`). An INSERT that omits it fails on the first row (code-standards §7 / rm06 D10 of rm01-adjacent).

### D9. The log-sweep — independent, three-outcome severity resolution

Scheduled, **independent of the rating flows** so a crashed flow still gets its logs loaded (a task at the end of each flow would never load that flow's crash). The sweep parses `logs/` and inserts into `process_log`:

- **`log_level` is the emitter's** — `DEBUG`/`INFO`/`WARN`/`ERROR`, passed through unchanged.
- **`perceived_severity` is the catalog's** — resolved by a `LEFT JOIN` on `event_catalog`, with **three** outcomes (Inv #14, rm02 §A1): row with a severity → that value; row with `default_severity` **NULL** → **NULL** (catalogued, deliberately non-alarming); **no row → `INDETERMINATE`** (the hygiene metric, must be zero). The resolver tests `event_catalog.event_code IS NULL`. **`COALESCE(default_severity,'INDETERMINATE')` is the wrong implementation** — it collapses outcome two into three and permanently voids the metric (success criterion 10).

The sweep connects as `rating_runtime` (`SELECT`/`INSERT` on `process_log`, `EXECUTE` on `rating.period_of` — rm03).

### D10. Idempotency and the awkward edges

`process_log` has no content-unique constraint and `log_id` is a fresh ULID per insert, so a retry or a second scheduled run would silently duplicate every line. The **mechanism (chosen): rename-on-completion** — a fully swept file is moved to `logs/swept/`; the sweep only reads unmarked files. Plus the edges rm00 rm06 requires be decided and stated:

- **Torn last line** (a file still open for writing): skip an incomplete final line, sweep it on the next run — never load a half-written record.
- **Malformed line:** quarantine to `logs/malformed/` and emit one `WARN`/`INDETERMINATE` summary; do **not** fail the whole sweep on one bad line.
- **The sweep's own failures:** it can no more sweep its own crash than a rating flow can, so it writes its **own** terminal log line (D7) and its execution is monitorable; a stuck/failed sweep is caught by the next scheduled run and a stuck-sweep alarm. File naming/rotation: the emitter writes per-execution files (`<component>-<workflow_execution_id>.jsonl`), so rotation is natural and a swept file never reopens.

### D11. Testing on a basic dummy sample (Open item 8)

A tiny fixture set: a **dummy sample usage file** (a handful of rows) to move through the stub sections, and a handful of **raw JSON log lines** — one whose `specific_problem` contains quotes, newlines and a pipe; one alarming code; one catalogued non-alarming code; one uncatalogued code. The test asserts the line **round-trips**, the sweep **loads** them, severity resolves **three ways**, **idempotency** holds, and a **deliberately crashed** flow's log still sweeps. No business-logic assertion — that is rm07+.

---

## Implementation

### 1. `flows/ran-usage-rating.yaml` — the template

```yaml
id: ran-usage-rating
namespace: rating
concurrency:
  limit: 1                       # per udr_type (D6); one of three layers
triggers:
  - id: manual                   # D3 — the landing/ file trigger is rm07's
    type: io.kestra.plugin.core.trigger.Webhook
tasks:
  - id: prp                      # STUB: rm07 — claim, validate, reject.
    type: io.kestra.plugin.scripts.python.Commands   # process runner (rm04)
    commands:
      - "python3 -c \"# STUB: rm07 owns PRP. Emits a file URI for rp.\""
    # emits {{ outputs.prp.uri }} (D5)
  - id: rp                       # STUB: rm08 — price resolution & snapshot.
    type: io.kestra.plugin.scripts.python.Commands
    commands:
      - "python3 -c \"# STUB: rm08 owns RP. Consumes prp's URI, emits rp's.\""
  - id: rl                       # STUB: rm09/rm10 — guard, supersede, load in ONE tx (Inv #8).
    type: io.kestra.plugin.scripts.python.Commands
    commands:
      - "python3 -c \"# STUB: rm09 owns RL. psycopg single transaction.\""
errors:                          # D7 — fires on failure
  - id: on-error
    type: io.kestra.plugin.scripts.python.Commands
    commands: ["python3 /runtime/emit_terminal_log.py --outcome FAILED"]
finally:                         # D7 — always runs
  - id: always
    type: io.kestra.plugin.scripts.python.Commands
    commands: ["python3 /runtime/emit_terminal_log.py --outcome FINALIZED"]
```

Every task also writes its per-section log lines via the emitter (§3). Task types are illustrative; the binding rules are the `# STUB:` markers, the order, the file-URI handoff, `concurrency: limit: 1`, and the error+finally handlers.

### 2. `flows/log-sweep.yaml` — the sweep

```yaml
id: log-sweep
namespace: rating
triggers:
  - id: schedule
    type: io.kestra.plugin.core.trigger.Schedule
    cron: "*/5 * * * *"          # cadence is namespace-KV config (rm00 §Configuration)
tasks:
  - id: sweep
    type: io.kestra.plugin.scripts.python.Commands
    commands: ["python3 /runtime/log_sweep.py --dir logs/ --swept logs/swept/ --malformed logs/malformed/"]
errors: [ ... terminal log line ... ]
finally: [ ... terminal log line ... ]
```

`log_sweep.py` (in the worker image, rm04): read unmarked `*.jsonl`, parse each line (torn-line and malformed handling, D10), resolve severity by the LEFT JOIN (§4), insert into `process_log` computing `partition_period = rating.period_of(log_datetime)`, then rename-on-completion. Connects as `rating_runtime`.

### 3. The log-line contract + emitter

A documented schema (the 12 fields, D8) and a small **`emit_terminal_log.py` / logging helper** in the worker image that writes a JSON Lines record to `logs/<component>-<execution_id>.jsonl`. The emitter is **real code** (logging is a contract), even though the pipeline sections are stubs. It never sets `perceived_severity` (that is the sweep's, via the catalog) and never sets `partition_period`.

### 4. Severity resolution SQL (the sweep's insert)

```sql
INSERT INTO rating.process_log (partition_period, log_datetime, component, log_level,
       perceived_severity, event_code, specific_problem, managed_object, alarm_key,
       source_file, batch_id, workflow_execution_id, additional_info)
SELECT rating.period_of($log_datetime), $log_datetime, $component, $log_level,
       ec.default_severity,            -- NULL when catalogued-non-alarming;
       $event_code, $specific_problem, $managed_object, $alarm_key,
       $source_file, $batch_id, $workflow_execution_id, $additional_info
FROM (SELECT 1) _
LEFT JOIN rating.event_catalog ec ON ec.event_code = $event_code;
-- If ec.event_code IS NULL (no row) → perceived_severity resolves to INDETERMINATE
--   in the emitter mapping, NOT via COALESCE. Test asserts the three outcomes.
```

The `IS NULL` (no-row) case is mapped to `INDETERMINATE` explicitly in the sweep, never by `COALESCE` over `default_severity` (which would swallow the deliberate-NULL case).

### 5. Idempotency + edge handling

Rename-on-completion to `logs/swept/`; per-execution file naming; torn-last-line deferral; malformed-line quarantine to `logs/malformed/` + one `WARN`; the sweep's own terminal log line. All per D10.

### 6. Flow deployment (D2 / Open item 5)

Add a **flow-deploy stage** to the rating-repo `azure-pipelines.yml`: on merge to `main`, `kestra flow validate ./flows` then `kestra flow namespace update rating ./flows`, authenticated with the Basic Auth secret from Key Vault. Document in `infra/docs/engine-access.md` that **the UI is read-only** and every flow change is a git commit deployed here.

### 7. Test fixtures + the rm06 guardrail (code-standards §10 #16)

`tests/rating/` (app repo, run by rm13's assembly): a dummy sample usage file, dummy `*.jsonl` log fixtures (D11), and the assertions in the checklist below, against a live database and a local engine (Azurite + local `kestra` DB, rm04 D9).

---

## Dependencies (packages to install)

**None new.** The worker image (rm04) already carries `psycopg` (the sweep's DB writes), `json`/`orjson` (log lines), and `polars`/`pyarrow` (unused by rm06 but present). The **`kestra` CLI** is added to the pipeline image for the deploy stage (a pipeline tool, not an app/worker dependency). No npm or Python package installs.

---

## Verification checklist

Live database + a running engine (real or local Azurite + local `kestra` DB). Dummy sample only (Open item 8).

**The spine (D1, D3, D4, D5, D6)**

1. A file moves through all three stub sections on a manual trigger and the flow reaches success.
2. Each of `prp`/`rp`/`rl` is a **`# STUB:`** naming its owning spec — a scan asserts **no** rate maths, parsing, `file_key` derivation, or guards are present (templates only).
3. Sections hand off by **file URI** (Kestra internal storage), not record payload.
4. `concurrency: limit: 1` is declared on the flow.
5. Both the `errors` and the `finally` handler write a terminal-outcome log line — verified by killing the flow mid-run and finding a `FINALIZED` line.

**Logging contract + sweep (D8, D9, D10, D11)**

6. Every component writes **JSON Lines** log entries; a line whose `specific_problem` contains quotes, newlines and a pipe **round-trips** intact (not a delimited format).
7. The sweep loads lines into `process_log` with severity resolved from the catalog.
8. In one run, an **alarming** code, a **catalogued non-alarming** code, and an **uncatalogued** code resolve to a **severity**, **NULL**, and **`INDETERMINATE`** respectively — the three outcomes stay distinguishable.
9. `COALESCE(default_severity,'INDETERMINATE')` is **not** used; the sweep uses the `LEFT JOIN` / `IS NULL` logic (assert the query shape).
10. `partition_period` is computed by the sweep as `rating.period_of(log_datetime)` and is **absent** from the log line.
11. `log_level` is the emitter's, passed through unchanged; `perceived_severity` is never set by the emitter.
12. **A deliberately crashed flow still has its logs swept in** (the sweep is independent).
13. **Sweeping the same file twice leaves the row count unchanged** (rename-on-completion idempotency).
14. A **malformed** line is quarantined to `logs/malformed/` and does not fail the sweep; a **torn last line** is deferred to the next run.
15. The `log_datetime`→`insert_datetime` lag is visible as a health metric.

**Deployment (D2)**

16. Flows deploy to Kestra **from git via the pipeline** (`kestra flow namespace update`); the flow in the engine matches the repo, and a UI edit is not the mechanism.

**Build hygiene**

17. `kestra flow validate ./flows` passes; the log-sweep and template YAML parse and deploy.
18. No secret in any flow; `{{ secret('…') }}` only (code-standards §3.8); no `console.*`; no `TODO` (only `# STUB:`).
