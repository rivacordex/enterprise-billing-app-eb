# `flows/reporting/` — function 4 (Reporting)

The read-only report flows that produce the files Finance, Mediation, the CSP
and the MNOs need from the billing data. Deployed to logical-engine namespace
**`reporting`**, on the engine that hosts `billrun` (the collapsed engine, or
the billrun instance under split-by-module, RF6). Module context:
`context/reporting-management/`.

**Maturity: platform check only (rpt01).** No report is built yet; the unit
list is `context/reporting-management/specs/rpt00-build-plan.md`.

| Flow | Description | Trigger | Since |
| --- | --- | --- | --- |
| `report-platform-check.yaml` | Reporting platform check — Revenue Ops' health check: connects as `reporting_runtime`, reads a granted table, publishes and delivers one file | manual | rpt01 |

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
