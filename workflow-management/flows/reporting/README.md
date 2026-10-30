# `flows/reporting/` — function 4 (Reporting)

The read-only report flows that produce the files Finance, Mediation, the CSP
and the MNOs need from the billing data. Deployed to logical-engine namespace
**`reporting`**, on the engine that hosts `billrun` (the collapsed engine, or
the billrun instance under split-by-module, RF6). Module context:
`context/reporting-management/`.

**Maturity: platform check, shared framework and the settlement reports
(rpt01–rpt03).** The unit list is
`context/reporting-management/specs/rpt00-build-plan.md`.

| Flow | Description | Trigger | Since |
| --- | --- | --- | --- |
| `report-platform-check.yaml` | Reporting platform check — Revenue Ops' health check: connects as `reporting_runtime`, reads a granted table, publishes and delivers one file | manual | rpt01 |
| `report-settlement-invoice.yaml` | Settlement reports (invoice and payment) — Part A for Finance / billing ops: `Reporting_dnb_settlement_invoice_<ts>.csv` and `Reporting_dnb_settlement_invoice_payment_<ts>.csv` for one `billing_period` and an `as_of_date` payment cut-off (default today); Kestra outputs only (SR24) | manual (OI-4) | rpt03 |
| `report-validate-date.yaml` | Reporting date check (shared subflow) — the one date rule; resolves an empty date to its default | called by reports | rpt02 |
| `report-validate-period.yaml` | Reporting period check (shared subflow) — `billing_period` + `as_of_date` (SR33) | called by reports | rpt02 |
| `report-validate-output.yaml` | Reporting output check (shared subflow) — a file against its column definition, before anything is published | called by reports | rpt02 (`name` input: rpt03) |
| `contracts/` | Column definitions, deployed as namespace files (format: [`contracts/README.md`](contracts/README.md)) | — | rpt02 |

**Role.** Every flow reads as **`reporting_runtime`** (`db/bootstrap/reporting-db-roles.sql`):
`SELECT` only, on an enumerated table list, with `default_transaction_read_only = on`.
Reporting never writes the database (Inv 1); a flow that needs a write is in
the wrong module. The runtime connects only through
`runtime/reporting/common/db.py` `read_snapshot()` — one `REPEATABLE READ READ
ONLY` transaction per run (Inv 2).

**Logic lives in the worker image** (`worker/workflow-engine/runtime/reporting/`),
settings in flow `variables`; the YAML orchestrates and computes nothing (Inv 13).

**Never edit a flow in the Kestra UI.** Flows are deployed from git — by the dev
`flow-deploy` compose service and the CI `deploy_workflow_flows` stage
(`flow namespace update reporting … --no-delete`, SR41). A UI edit is an
untracked change to a financial file.

## Run trace (RF7)

Every execution carries the labels `report=<name>` (flow-level) and
`flow_revision=<n>`, and logs one INFO line per published file:

```
DELIVERED <filename> sha256=<hex> rev=<n>
```

`flow_revision` is set by a `io.kestra.plugin.core.execution.Labels` task
(`flow_revision: "{{ flow.revision }}"`), **not** by flow-level `labels:` —
verified on the pinned v1.3.35 (rpt01, 2026-10-30): flow-level label values
are stored literally, never rendered. The `DELIVERED` line comes from
`common/trace.py` `delivered()`, with the same revision passed as an argument.

Log lines go through Kestra's script-log protocol
(`::{"logs":[{"level":…,"message":…}]}::` on stdout, `common/trace.py`), which
v1.3.35 parses into the given level — so `DELIVERED` is INFO and
`PLATFORM_CHECK_FAILED …` is ERROR, never stray stdout/stderr text.

## SUCCESS / WARNING / FAILED — the verified mechanism (rpt02 onward)

Verified on v1.3.35 with `report-platform-check` (rpt01, 2026-10-30):

1. **Exit 0 means the runtime finished** (SUCCESS or WARNING); **any non-zero
   exit is FAILED** — the `Commands` task fails and so does the execution.
   WARNING is never an exit code (`warningOnStdErr` is a no-op on v1.3.35, so
   stderr output does not change the state either).
2. The runtime emits the **`status` output** (`SUCCESS` | `WARNING`) through
   `common/trace.py` `set_status()`, read as `outputs.<task>.vars.status`.
3. The flow's last task applies it:

   ```yaml
   - id: set_status
     type: io.kestra.plugin.core.flow.If
     condition: "{{ outputs.<task>.vars.status == 'WARNING' }}"
     then:
       - id: warning
         type: io.kestra.plugin.core.execution.Exit
         state: WARNING
   ```

   The execution ends **WARNING**; with `status = SUCCESS` the `If` evaluates
   false and the execution ends SUCCESS.

Output files are exposed with the `Commands` task's `outputFiles` (glob
patterns relative to the task's working directory); the runtime writes them
there only after the run's checks (and any delivery) have passed, so a failed
run publishes none.

## Shared subflows — the calling pattern (rpt02 D4)

Every report checks its inputs and its files with the shared subflows, called
— never copied (code-standards §3.5). Verified on v1.3.35 (rpt02, 2026-10-30):

```yaml
- id: validate_date
  type: io.kestra.plugin.core.flow.Subflow
  namespace: reporting
  flowId: report-validate-date
  wait: true            # the caller waits for the subflow's state
  transmitFailed: true  # a FAILED check fails the caller
  inputs:
    name: report_date   # names the failure code: INVALID_REPORT_DATE
    value: "{{ inputs.report_date }}"
    rule: before_today  # or not_future
    default: yesterday  # or today — as the report's spec states
```

The subflow's flow-level `outputs` are read as
**`{{ outputs.<task id>.outputs.<output id> }}`** — here
`{{ outputs.validate_date.outputs.effective_date }}`.

| Subflow | Inputs | Outputs | Fails with |
| --- | --- | --- | --- |
| `report-validate-date` | `name` (one of `common/codes.py` `INVALID_INPUT_NAMES`), `value` (may be empty), `rule` (`not_future` \| `before_today`), `default` (`today` \| `yesterday`) | `effective_date` (`YYYYMMDD`) | `INVALID_<NAME>` |
| `report-validate-period` | `billing_period` (`YYYYMM`), `as_of_date` (may be empty: today) | `period_start`, `period_end`, `effective_as_of_date` | `INVALID_BILLING_PERIOD`, `INVALID_AS_OF_DATE` |
| `report-validate-output` | `file` (`FILE`), `contract` (an id), `name` (optional: the file name the log shows) | `rows` (data rows) | `OUTPUT_CONTRACT_VIOLATION`, `CONTRACT_INVALID` |

- **Defaults are resolved in the runtime**, not in Kestra input `defaults`, so
  "today in Kuala Lumpur" exists in one place (`common/period.py`).
- `report-validate-period` checks the period first, then calls
  `report-validate-date` for `as_of_date` (rule `not_future`, default `today`),
  then checks the date is not before the period's first day — two `Commands`
  tasks around the subflow call, so the YAML computes nothing (Inv 13). A
  failure in the nested date check is logged in **its** execution (the
  `as_of_date` task's `executionId`).
- Inputs reach the shell as **env vars**, never interpolated into the command
  text, so an input value can't inject shell syntax.
- A failed check's execution also logs `Failed to render output values …`:
  Kestra still renders the flow's `outputs` after the task failed. It is
  noise; the code line above it is the outcome.

## Output check (rpt02 D6)

Each report calls `report-validate-output` once per file, between `generate`
and `publish` (code-standards §3.2), passing the generated file and its
contract id:

```yaml
- id: validate_output
  type: io.kestra.plugin.core.flow.Subflow
  namespace: reporting
  flowId: report-validate-output
  wait: true
  transmitFailed: true
  inputs:
    file: "{{ outputs.generate.outputFiles['<file name>'] }}"
    contract: polygon_capacity
    name: "<file name>"
```

Nothing is published or delivered if it fails (Inv 5). The check runs
`python3 -m runtime.reporting.validate output` with the namespace files
`contracts/**` in its working directory. The log lines name the file by the
`name` input, else by the `FILE` URI's last segment. **Pass `name` for a
generated file** — verified on v1.3.35 (rpt03): an uploaded `FILE` input's URI
keeps the original name (`…/inputs/file/<name>`), but a task's output file is
stored as `<id>-<name>`, so without `name` the log would show the storage
prefix. The lines are:

```
OUTPUT_CONTRACT_VIOLATION <file> <row> <column> <reason>
```

one ERROR line per violation (at most 50, then `… <n> more`); `<row>` is the
1-based file line, `<column>` the contract's column name (it may contain
spaces; the reason is always the last word) or `-`. Reasons and the contract
format: [`contracts/README.md`](contracts/README.md).

## Published files (rpt03 D8)

A report's published files are the **`publish` task's output files**:
`publish` runs only after every `validate_output` call has passed, takes the
generated files as `inputFiles` (keyed by their names — Pebble renders the
keys, verified on v1.3.35), logs one `DELIVERED` line per file with
`python3 -m runtime.reporting.common.trace delivered --flow-revision <n>
<file> …`, and lists them in `outputFiles`. Revenue Ops download them from the
`publish` task in the execution's Outputs.

- **No flow-level `outputs:`.** Verified on v1.3.35 (rpt03): when the `Exit`
  task ends a run WARNING, Kestra does not render the flow's `outputs`, so
  they would exist on SUCCESS runs only. The `publish` task's files exist on
  SUCCESS and WARNING alike.
- **`generate`'s copies.** The output check reads the files as a subflow
  `FILE` input, which must already be in Kestra's internal storage, so
  `generate` lists them in its own `outputFiles`. Those copies stay task
  outputs of `generate` even when a check fails; they are the input to the
  check, not a published file, and carry no `DELIVERED` line. A FAILED run
  never has a `publish` task, so it publishes nothing.

## Namespace files — deploying the contracts (rpt02 D8)

The contracts are the platform's first **Kestra namespace files**: uploaded to
namespace `reporting` at `contracts/` by the dev `flow-deploy` service and the
CI `deploy_workflow_flows` stage, right after the `reporting` flows, with the
same pinned image and credential:

```
kestra namespace files update reporting <checkout>/workflow-management/flows/reporting/contracts contracts/ \
  --no-delete --server <url> --user <user:password>
```

Verified on v1.3.35 (rpt02, 2026-10-30): files land at `contracts/<name>`;
re-deploying uploads the same bytes (no change); a file edited in git is
updated on the next deploy. The command prints `WARNING: this command is
deprecated, use kestractl nsfile upload instead`: `kestractl` is a separate
tool the pinned image doesn't ship, and the command works — revisit when the
base image is bumped. `--no-delete` keeps the upload additive, like the flows:
a contract removed from git stays on the engine until removed deliberately.

Contracts are deployed with their flows and never edited in the Kestra UI
(SR41).

## Outbound destinations (RF8)

A **separate storage account** (`infra/bicep/modules/reporting-outbound-storage.bicep`)
with **one Azure Files share per destination** (Azure Files can't scope read
access to a folder, rpt04 D1), each mounted at `/data/outbound/<outbound_dir>/`
on the engine. Secure transfer, SMB 3.1.1 with AES-256-GCM only. The account
key goes from the account to the Container Apps Environment at deploy time and
never reaches Kestra, the runtime or the repository. Locally,
`workflow-management/dev/outbound/` is bind-mounted at `/data/outbound`.

Files are delivered by write-then-rename (`.<name>.tmp` → `<name>`), and a
delivered file is never overwritten (Inv 11). Each row's audience is recorded
here and in the bicep module; reader access is agreed when the destination is
set up (RF-OI2), and grants access to that share only.

| `outbound_dir` | Share | Readers | Report | Since |
| --- | --- | --- | --- | --- |
| `_platform-check/` | `platform-check` | none (no external reader) | `report-platform-check` | rpt01 |
