# rpt02 — Shared Reporting Framework: Date & Period Checks, Column Definitions, CSV Writer, Output Check

**Unit:** rpt02. **Boundary:** RUNTIME (`runtime/reporting/common/{codes,period,csv_writer,contract}.py`, `runtime/reporting/validate/`), FLOWS (three shared subflows, `contracts/` format), plus the worker's `requirements.in`/`requirements.txt` (PyYAML) and the namespace-file deploy step (dev compose, CI).

**Specs from:** `_newmodule-reporting-plan.md` RF2–RF4, SR25, SR30, SR33–SR35, PC16, PC20, MO9, IC14, GL3; tests T17, T19, the format half of T18 and P-T11, P-T10; `rptmgmt-architecture.md` Inv 5, 8, 9, 10; `rptmgmt-code-standards.md` §2, §3, §5, §6, §9.2–9.3; `specs/rpt00-build-plan.md` rpt02.

**Depends on:** rpt01 (namespace `reporting`, `common/db.py`, `common/trace.py`, the WARNING contract, deploy wiring).

---

## Goal

Build once what every report uses, so rpt03–rpt09 add only their own extract and builder:

1. **one date rule** (`report-validate-date`) and **one period rule** (`report-validate-period`), each resolving its default and failing with a fixed code;
2. **one column-definition format** for both file shapes (`header: true | false`), stored as YAML namespace files;
3. **one CSV writer** that produces every file byte-for-byte the same way;
4. **one output check** (`report-validate-output`) that refuses to let a bad file through;
5. **one register** of outcome codes, checked by a guardrail.

No report is built here.

---

## Design

### D1 — Column definitions are YAML, read with PyYAML (Q1, 2026-10-29)

- **PyYAML** is added to `worker/workflow-engine/requirements.in`, pinned to an exact version, and `requirements.txt` is recompiled with hashes (the `uv` command in its header). It's the first library this module adds; it arrives in the unit that first reads a contract.
- It's only ever used through **`yaml.safe_load`**. A guardrail (T-R02-12) fails on any other loader.
- YAML is kept (RF3, SR35) because comments let each contract record its readers and the decision behind each column, next to the column.

### D2 — The contract format

One file per output file, `flows/reporting/contracts/<id>.yaml`. rpt02 fixes the schema; each report unit adds its own contract.

```yaml
# <file name pattern> — <readers>. Changing this file changes what <readers> receive:
# agree it with them first (rptmgmt-architecture Inv 9).
id: polygon_capacity                 # equals the file name without .yaml
file: Polygon_capacity_lookup_<report_date>.csv
header: false                        # true: the first line must equal the column names, joined by commas
columns:
  - name: mno_public_key             # with header: true, this is the exact header text
    type: text                       # text | date | amount | integer
    required: true
    # decision: PC4; source lkp.mno_public_key
  - …
```

- Allowed keys only: `id`, `file`, `header`, `columns`, and per column `name`, `type`, `required`. Anything else makes the contract invalid (`CONTRACT_INVALID <id> <reason>`), so a typo can't silently switch a check off.
- `name` values are unique within a contract. With `header: true` they're compared **exactly**, including spaces and case (IC6, GL10).
- Report-specific checks (SR19's per-invoice sum, IC18's equal `Invoice Amount`, GL20's reconciliation) are not in the contract; they stay in each report's module and fail with the same code (SR34).
- rpt02 ships no report contract. Its tests use fixture contracts under the runtime's test folder.

### D3 — Type rules (RF3)

| Type | Valid value | Notes |
|---|---|---|
| `date` | `YYYYMMDD`, eight digits, a real calendar date | `20261301` and `20260230` fail |
| `amount` | `^-?(0\|[1-9][0-9]*)\.[0-9]{2}$` | exactly 2 dp, no `+`, no thousands separator, no `-0.00` |
| `integer` | `^-?(0\|[1-9][0-9]*)$` | no leading zeros, no `-0` |
| `text` | any string without CR or LF | quoting is the writer's concern (D5) |

- `required: true`: the field may not be empty. `required: false`: an empty field passes; a non-empty one must match its type.

### D4 — `common/period.py` and the two date subflows (RF2, SR25, SR33)

- **One function per rule**, all in Asia/Kuala_Lumpur (`zoneinfo`, never the host or session time zone):
  - `parse_date(text)` → a date, or `None` if not `YYYYMMDD` / not a real date;
  - `check_date(value, rule, today)` with `rule` ∈ `not_future` (≤ today) and `before_today` (≤ yesterday);
  - `parse_period(text)` → (first day, last day) of a `YYYYMM` month;
  - `resolve_default(rule)`: `today` for `not_future` inputs that default to today (SR40's `as_of_date`), `yesterday` for the rest (PC15, MO9, IC14, GL3). The report's spec states which default it uses; the subflow takes it as an input.
- **`report-validate-date`** (subflow). Inputs: `name` (the input's name, e.g. `report_date`), `value` (string, may be empty), `rule`, `default` (`today` \| `yesterday`). It resolves an empty value to its default, applies the rule, and returns `effective_date`. On failure: FAILED with `INVALID_<NAME uppercased>` (`INVALID_REPORT_DATE`, `INVALID_AS_OF_DATE`, …). Defaults are computed here, not in Kestra input `defaults`, so "today in Kuala Lumpur" exists in one place.
- **`report-validate-period`** (subflow, SR33). Inputs: `billing_period`, `as_of_date`. It checks `billing_period` (`INVALID_BILLING_PERIOD`), calls `report-validate-date` for `as_of_date` (rule `not_future`, default `today`), then checks `as_of_date` is not before the period's first day (`INVALID_AS_OF_DATE`). Outputs: `period_start`, `period_end`, `effective_as_of_date`.
- `report-validate-date` runs `python3 -m runtime.reporting.validate date …` in one `Commands` task on the `Process` runner. **As built (accepted 2026-10-30):** `report-validate-period` runs two `Commands` tasks on the `Process` runner around its `report-validate-date` call — `check_period` (`validate period --billing-period`) before it, `check_as_of` (`validate period --billing-period --as-of-date`) after it — so the check order above holds with no computation in YAML (Inv 13). Neither subflow reads the database.
- **Calling pattern for every report:** `io.kestra.plugin.core.flow.Subflow` with `namespace: reporting`, `wait: true`, `transmitFailed: true`, then reading the subflow's outputs. The exact output-passing syntax on v1.3.35 is fixed in `flows/reporting/README.md` when built.

### D5 — `common/csv_writer.py` (RF4)

- `write_csv(path, contract, rows)`: rows are sequences of already-formatted strings in contract column order; the writer formats nothing itself. Formatting helpers live beside it: `fmt_date(date)`, `fmt_amount(Decimal)` (half-up to 2 dp, `-0.00` → `0.00`), `fmt_integer(Decimal)` (half-up to a whole number, PC9), `fmt_blank()`.
- Output bytes: UTF-8, **no BOM**; fields joined by `,` with **no spaces**; **LF** line endings, including after the last line; a field is quoted only when it contains `,` or `"`, with `"` doubled (RFC 4180). A field containing CR or LF is refused (`WRITER_INVALID_VALUE`), never written.
- `header: true` writes the column names as the first line, exactly; `header: false` writes none.
- The writer counts columns against the contract and refuses a row with the wrong count. It doesn't check types: that's `report-validate-output`'s job, so the check is independent of the code that wrote the file.
- Python's `csv` module is not used, so the output can't drift with its dialect defaults.

### D6 — `common/contract.py` and `report-validate-output` (SR30, SR34, RF3)

- **`common/contract.py`:** `load_contract(path)` (D2 rules, `safe_load` only) and `check_file(path, contract)` → a list of violations, each `(row, column, reason)`. It checks, in order, stopping at the first failing stage:
  1. **bytes:** UTF-8 decodes; no BOM; no CR anywhere; the file ends with LF (an empty file with `header: false` fails `EMPTY_FILE`);
  2. **header:** with `header: true`, line 1 equals the names joined by `,`;
  3. **shape:** every data line parses (RFC 4180) to exactly N fields;
  4. **fields:** each field against D3.
- Row numbers are 1-based **file lines**, so they match what someone sees in an editor (the header is line 1 when present).
- **`report-validate-output`** (subflow). Inputs: `file` (a Kestra `FILE`), `contract` (an id). It runs `python3 -m runtime.reporting.validate output --contract contracts/<id>.yaml --file <path>` with `namespaceFiles: { enabled: true, include: ["contracts/**"] }`.
  - Clean: SUCCESS, with output `rows` (data rows).
  - Violations: FAILED. It logs one `ERROR OUTPUT_CONTRACT_VIOLATION <file> <row> <column> <reason>` per violation (at most 50, then `… <n> more`), so T19 can name the first one exactly.
  - Unreadable or invalid contract: FAILED `CONTRACT_INVALID <id> <reason>`.
- Each report calls it once per file, between `generate` and `publish` (`code-standards` §3.2); nothing is published if it fails (Inv 5).

### D7 — `common/codes.py`, the executable register

- `codes.py` holds every outcome code and log-line prefix as constants, grouped FAILED / WARN / INFO, and is the only place a runtime module gets them from.
- rpt02 adds: `INVALID_<NAME>` (built through one function, not a free-form string), `INVALID_BILLING_PERIOD`, `OUTPUT_CONTRACT_VIOLATION`, `CONTRACT_INVALID`, `WRITER_INVALID_VALUE`, `EMPTY_FILE` (a violation reason), and rpt01's `PLATFORM_CHECK_FAILED` and `DELIVERED` (moved in from rpt01's modules).
- **Guardrail 2** (T-R02-11): every code string a runtime module logs comes from `codes.py`, and the set in `codes.py` equals the register table in `rptmgmt-code-standards.md` §6 (the codebase's `context/` copy). Adding a code means adding it in both places in the same change.

### D8 — Deploying namespace files

- rpt02 is the **first use of Kestra namespace files** on the platform. The dev `flow-deploy` service and the CI `deploy_workflow_flows` stage each gain one step after the `reporting` flow deploy: upload `flows/reporting/contracts/` to namespace `reporting` at path `contracts/` with the CLI `namespace files update` command on the pinned image, idempotently.
- The exact CLI syntax and flags on v1.3.35 are verified when built and written into `flows/reporting/README.md`. If the pinned CLI can't upload namespace files, the implementer stops and raises it (no workaround inside the unit).
- Contracts are deployed with their flows and never edited in the Kestra UI (SR41).

### D9 — What rpt02 does not do

No report flow, extract or contract; no `receivables.py`, `polygon_lines.py` or `encrypt.py` (rpt03, rpt08, rpt09); no folder delivery helpers (rpt04 owns PC13/PC14); no new grant.

---

## Implementation

1. **Dependencies:** `requirements.in` + recompiled `requirements.txt` (PyYAML, D1); rebuild the worker image.
2. **Runtime:** `runtime/reporting/common/{codes,period,csv_writer,contract}.py`; `runtime/reporting/validate/{__init__,__main__}.py` with subcommands `date`, `period`, `output`; move rpt01's literal codes into `codes.py`.
3. **Flows:** `flows/reporting/report-validate-date.yaml`, `report-validate-period.yaml`, `report-validate-output.yaml`; `flows/reporting/contracts/README.md` describing D2 and D3 (no contract files yet).
4. **Deploy:** the namespace-file step in dev compose and CI (D8).
5. **README:** `flows/reporting/README.md` gains the subflow calling pattern (D4), the output check (D6) and the namespace-file deploy (D8).

## Tests

Tests are vitest suites in `tests/reporting/` using rpt01's `reporting-harness.ts`; "unit" means no database.

| # | Test | Where | Expected |
|---|---|---|---|
| T-R02-1 | Dates (part of T17, P-T10) | `period.py` unit | `20261332`, `2026103`, `20260230` invalid; `not_future`: today passes, tomorrow fails; `before_today`: yesterday passes, today fails; "today" taken in Asia/Kuala_Lumpur at 23:59 and 00:01 local, under host time zones UTC and Asia/Kuala_Lumpur |
| T-R02-2 | Periods (part of T17) | `period.py` unit | `202613` and `20269` invalid; `202602` → 20260201–20260228; `as_of_date` 20260815 for `202609` fails `INVALID_AS_OF_DATE` |
| T-R02-3 | `report-validate-date` | local Kestra | empty value → `effective_date` = default; `20261332` → FAILED `INVALID_REPORT_DATE`; the code name follows the `name` input |
| T-R02-4 | `report-validate-period` (T17) | local Kestra | `202613`; `20261332`; `as_of_date` tomorrow; 20260815 for 202609 → FAILED with the SR25 code; a valid pair returns the period bounds |
| T-R02-5 | Writer format (T18 / P-T11 format half) | `csv_writer.py` unit | byte-compare against fixtures: no BOM, LF only and after the last line, no spaces after commas, header written or not per contract, `1234.5` → `1234.50`, `-0.004` → `0.00`, `1000.5` → integer `1001` |
| T-R02-6 | Quoting | `csv_writer.py` unit | a value with a comma is quoted; with `"` it's quoted with the quote doubled; a value with LF is refused `WRITER_INVALID_VALUE` |
| T-R02-7 | Contract loading | `contract.py` unit | an unknown key, an unknown type, a duplicate name, or `id` ≠ file name → `CONTRACT_INVALID` |
| T-R02-8 | Output check (T19) | `contract.py` unit + local Kestra | a swapped column (header: true), `20261301` in a date column, `12.5` in an amount column, a 7-field row in an 8-column contract, a BOM, a CRLF line, an empty required field → FAILED `OUTPUT_CONTRACT_VIOLATION` naming file, row and column; the first violation's row and column are exact |
| T-R02-9 | Output check passes | same | the writer's own output for a fixture contract of each shape passes; `rows` output equals the data-row count; a header-only file passes with `header: true` and `rows = 0` (GL17) |
| T-R02-10 | Namespace files | dev `flow-deploy`, CI stage | `contracts/` exists in namespace `reporting` after deploy; re-deploy changes nothing; a contract edited in git is updated after deploy |
| T-R02-11 | Register (guardrail 2) | repo test | every logged code comes from `codes.py`; `codes.py` and `rptmgmt-code-standards.md` §6 list the same codes |
| T-R02-12 | Safe YAML only | repo test | no `yaml.load(`, `yaml.full_load(`, `yaml.unsafe_load(` or `Loader=` anywhere under `runtime/reporting/` |
| T-R02-13 | Hash lock | build | `requirements.txt` installs with `--require-hashes`; the image builds |

## Docs to sync in the same change set

- `rptmgmt-code-standards.md`: §5.2 (contract schema and allowed keys, D2), §6 (rows for `CONTRACT_INVALID`, `WRITER_INVALID_VALUE`, `EMPTY_FILE`; note that `codes.py` is the executable register, D7), §8 (`common/codes.py`, `runtime/reporting/validate/`).
- `rptmgmt-architecture.md` §1: PyYAML as the module's first library.
- `rptmgmt-progress-tracker.md`, `specs/rpt00-build-plan.md` status.

## Verification checklist

1. T-R02-1–T-R02-13 pass; the Kestra cases on a local engine.
2. Python lint and unit tests green; flows parse and deploy; the image builds with hashes.
3. No report flow, contract, grant or `common/` module beyond D9's list.
4. `report-validate-date` has one `Commands` task; `report-validate-period` has `check_period` → `as_of_date` (the date subflow) → `check_as_of` (D4).
5. Docs synced (above); the subflow, output and namespace-file mechanics recorded in `flows/reporting/README.md`.
