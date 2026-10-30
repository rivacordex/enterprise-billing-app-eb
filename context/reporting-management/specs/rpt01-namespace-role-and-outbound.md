# rpt01 — `reporting` Namespace, `reporting_runtime` Role, Deploy Wiring & Outbound Share

**Unit:** rpt01 (first Reporting Management unit). **Boundary:** ROLE (`db/bootstrap/reporting-db-roles.*`), FLOWS (`flows/reporting/` directory, README, one check flow), RUNTIME (`runtime/reporting/` package skeleton: `common/db.py`, `common/trace.py`, `platform_check/`), INFRA (bicep outbound account + mount, engine env wiring, dev compose, CI deploy stage). Kept as one unit by owner decision (2026-10-29): no part has a visible result on its own.

**Specs from:** `rptmgmt-architecture.md` §2–§4, Inv 1, 12, 13; `rptmgmt-code-standards.md` §2, §3, §7, §9.1; `_newmodule-reporting-plan.md` RF1, RF5–RF8, SR39, SR41, PC12, PC24, MO19; `context/workflow-management/wfm-architecture.md` §5, §6, §10; `context/architecture.md` §3 (egress), §4 (DB roles); `specs/rpt00-build-plan.md` rpt01.

**Precedents in the codebase:** `db/bootstrap/billrun-db-roles.{sql,ts}` (bm14), `infra/bicep/modules/workflow-engine-storage.bicep` and `workflow-engine-container-app.bicep` (rm04, bm38), `workflow-management/worker/workflow-engine/runtime/db.py`, the dev `flow-deploy` compose service and the CI `deploy_workflow_flows` stage (wfm01 §7b).

---

## Goal

Stand up everything the five reports share on the platform, and prove it works end to end with one small check flow:

1. a `SELECT`-only Postgres login **`reporting_runtime`**, granted the tables Parts A–C read;
2. the Kestra namespace **`reporting`** and its directory, deployed from git in dev and CI like the other functions;
3. a **separate storage account** for reporting outbound files, mounted into the engine at `/data/outbound`;
4. the run-trace convention (`flow_revision` label, `DELIVERED` line) and the WARNING mechanism, verified on the pinned Kestra version (v1.3.35).

No report is built here.

---

## Design

### D1 — The role: `reporting_runtime` (Q3, 2026-10-29)

- Created by `db/bootstrap/reporting-db-roles.sql`, run by `db/bootstrap/reporting-db-roles.ts` via `npm run db:bootstrap-reporting-roles` (`BOOTSTRAP_DATABASE_URL`, superuser/owner). Not a Drizzle migration: creating a role needs `CREATEROLE`.
- `LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10`. Idempotent, with billrun's convergent `ELSE` branch: attributes reset to least privilege, and the script **fails closed** on membership or ownership drift.
- **`ALTER ROLE reporting_runtime SET default_transaction_read_only = on`.** Every session starts read-only even before the runtime sets it. Defence in depth for Inv 1; the grants remain the guarantee.
- **Provisioning order:** `roles → rating-roles → billrun-roles → reporting-roles` (then `kestra-roles` as today). Step 0 is billrun's precondition: fail with `ORDERING:` if `PUBLIC` still holds `CONNECT` on the database.
- **No password in the file.** The manual `ALTER ROLE reporting_runtime PASSWORD …` follow-up, sourced from Key Vault secret `reporting-runtime-db-password`, is added to `infra/docs/db-role-verification.md` as step 3c.

### D2 — Grants: Parts A–C, `SELECT` only

| Schema | `USAGE` | `SELECT` on |
|---|---|---|
| `billing` | yes | `customer_bill`, `document`, `document_line`, `billing_account`, `financial_account`, `ledger_binding` |
| `customer` | yes | `party_role` |
| `product` | yes | `ratecard_version`, `ratecard_ran_usage_lkp` |

- Grants are enumerated per table (`code-standards` §7): never `ON ALL TABLES`, no `ALTER DEFAULT PRIVILEGES`, no sequence `USAGE`, no `EXECUTE`.
- **The pgledger objects in SR39 are deferred to rpt03.** Parts A and C compute balances from posted documents (SR14, MO3), and the live-ledger comparisons (SR14's pin test, MO-T11) run as the test harness's own connection. rpt03's spec fixes SR14's method and adds `SELECT` on the exact pgledger view(s) then, if the runtime reads them at all. This keeps the grant list just in time.
- `rating`, `customer_bill_line`, `product_offering`, `product_offering_price`, `gl_mapping`, `reason_code` and `bill_cycle` arrive with rpt08 and rpt09 (IC23, GL25).
- **Explicit `REVOKE`s for the record:** `INSERT, UPDATE, DELETE, TRUNCATE` on every granted table, and `EXECUTE` on the four `billing.pgledger_*` SECURITY DEFINER functions. They're no-ops on a fresh role but make the boundary readable and survive a future accidental grant to `PUBLIC`.
- No `CONNECT` on the `kestra` database (`kestra-db-roles.sql` already revokes it from `PUBLIC`; the guardrail asserts it).

### D3 — Credentials (Q2, 2026-10-29; RF5 corrected)

Reporting owns exactly these, and nothing else:

| Credential | Source | Applied |
|---|---|---|
| `reporting_runtime` password | Key Vault `reporting-runtime-db-password` (bare password) | `ALTER ROLE … PASSWORD` (manual, D1); exposed to the engine as `SECRET_REPORTING_RUNTIME_PASSWORD` |
| Outbound storage account key | The account itself, read by ARM `listKeys()` at deploy time | The Container Apps Environment storage definition only (D7); never an engine env var or Kestra secret |

- **No Basic-Auth credential.** Kestra OSS has one instance login; the per-engine credential in wfm §5 guardrail 2 is the app's credential for calling an engine, and the app never calls reporting. The app credential and the registry entry arrive with I-OI3 (RF5).
- **The outbound key is not copied into Key Vault.** It follows the `landing` mount's mechanism: the deployment reads it from the account and hands it to the platform. It is never surfaced to Kestra, the runtime or the repository. (This refines what was said when Q1 was decided: the separate account is what gives the separate credential.)
- Non-secret engine env vars: `REPORTING_DB_HOST`, `REPORTING_DB_PORT`, `REPORTING_DB_NAME`, `REPORTING_DB_USER` (= `reporting_runtime`), `REPORTING_DB_SSLMODE`, `REPORTING_DB_SSLROOTCERT`, same shape as `RATING_DB_*`.

### D4 — Runtime package skeleton

```
runtime/reporting/
├── __init__.py
├── common/
│   ├── __init__.py
│   ├── db.py        # reporting_runtime connection; one REPEATABLE READ READ ONLY transaction
│   └── trace.py     # flow_revision label, sha256, the DELIVERED line, Kestra outputs/status lines
└── platform_check/
    ├── __init__.py
    └── __main__.py
```

- **`common/db.py`** mirrors `runtime/db.py`'s DSN assembly with `REPORTING_DB_*` and refuses to connect without `SECRET_REPORTING_RUNTIME_PASSWORD`. It exposes one context manager, `read_snapshot()`, that opens a connection, runs `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY` as its first statement, and closes it on exit (Inv 2). It never returns or logs the DSN. Numeric values stay `Decimal`.
- **`common/trace.py`** owns the RF7 convention so every report emits it identically:
  - `delivered(path, revision)` computes SHA-256 and logs `INFO DELIVERED <filename> sha256=<hex> rev=<n>`;
  - `set_status(status)` emits the Kestra output that `set_status` reads (D8);
  - helpers that emit `::{"outputs": …}::` lines, as `runtime/storage.py` does.
- These two are added to the `common/` list in `rptmgmt-code-standards.md` §8 (the plan's list had only the report-facing modules).

### D5 — Namespace and directory

- `workflow-management/flows/reporting/README.md`: function 4, namespace `reporting`, maturity "platform check only (rpt01)", the flow table, the outbound destinations table (D7), the role, and "never edit in the Kestra UI".
- `workflow-management/flows/README.md`: a fourth row — `reporting/` · 4 · Reporting · `reporting` · platform check (rpt01).
- `workflow-management/README.md`: `reporting/` in the tree and in the naming rule's examples.
- `worker/workflow-engine/runtime/README.md`: one line pointing at `runtime/reporting/`.

### D6 — Deploy wiring (SR41)

- **Dev:** the `flow-deploy` compose service's `dir:namespace` map gains `reporting:reporting` (`flow namespace update reporting /flows --no-delete`). The function root holds only real flows, so no `local-dev/` indirection.
- **CI:** `deploy_workflow_flows` in `infra/azure-pipelines.yml` gains the same line, after `billrun`.
- **Topology:** reporting deploys to the engine that hosts `billrun` (collapsed engine, or the billrun instance under split-by-module, RF6). The bicep wiring in D7 follows the existing `hostsBillrunNamespace` parameter (bm38): a new parameter `enableReporting` (default `false`), set `true` at exactly the call sites in `main.bicep` that set `hostsBillrunNamespace: true`.
- Namespace files (`contracts/`) are **not** deployed here; rpt02 adds them with the first contract.

### D7 — Outbound storage account and mount (Q1, 2026-10-29; RF8)

New module `infra/bicep/modules/reporting-outbound-storage.bicep`, wired from `main.bicep` only when `enableReporting`:

- A **separate** `StorageV2` account (`Standard_LRS`), name from a new parameter, not the engine's account:
  - `supportsHttpsTrafficOnly: true` (secure transfer required; on Azure Files this refuses unencrypted SMB),
  - `minimumTlsVersion: 'TLS1_2'`, `allowBlobPublicAccess: false`, `allowSharedKeyAccess` left enabled (the ACA mount needs the key, as for `landing`),
  - file service `protocolSettings.smb`: `versions: 'SMB3.1.1'`, `channelEncryption: 'AES-256-GCM'`.
- One share, `outbound`. Subfolders are created by the reports that use them (`polygon-capacity/` in rpt04); rpt01 creates `_platform-check/` through the check flow. **Amended by rpt04 D1 (2026-10-29):** one share **per destination**, because Azure Files can't scope read access to a folder. rpt01's share is named `platform-check` and mounted at `/data/outbound/_platform-check/`; each later destination adds its own share and mount.
- An environment storage definition (`Microsoft.App/managedEnvironments/storages`), name from a parameter defaulting to `reporting-outbound` (unique per instance, as `landingEnvStorageName`), `ReadWrite`, authenticated with the account key via `listKeys()`.
- `workflow-engine-container-app.bicep`: when `enableReporting`, a volume and a mount at **`/data/outbound`**, plus the D3 env vars and the `reporting-runtime-db-password` Key Vault secret reference exposed as `SECRET_REPORTING_RUNTIME_PASSWORD`.
- **Reader access is out of scope.** How Mediation and the CSP read the account (SAS, their own identity, or the key) is agreed when their folder is set up (rpt04 for Mediation/CSP). Whatever is chosen grants access to this account only.
- **Audience is recorded where the destination is defined:** the `flows/reporting/README.md` _Outbound destinations_ table (`outbound_dir`, readers, report, since) and a matching comment in the bicep module. rpt01's only row is `_platform-check/` → no external reader.
- **Local dev:** compose mounts `./workflow-management/dev/outbound:/data/outbound` on the engine, with a `README.md` and `.gitignore` in that folder like `landing/`. No `allowed-paths` change in `kestra.yml`: the Python runtime writes the files, not the `fs.local` plugins.

### D8 — The check flow `report-platform-check` and the WARNING mechanism

`flows/reporting/report-platform-check.yaml`, description "Reporting platform check", namespace `reporting`, manual trigger. It stays deployed as Revenue Ops' health check after rpt01.

- **Input:** `simulate_warning` (boolean, default `false`). It exists only so the WARNING path can be proven in place; it changes nothing else.
- **Tasks:**
  1. `check`: `io.kestra.plugin.scripts.python.Commands` on the `Process` runner, `python3 -m runtime.reporting.platform_check`. The runtime:
     - opens `read_snapshot()` and reads `current_user`, `current_setting('transaction_read_only')`, `current_setting('transaction_isolation')`, and `count(*)` from one granted table (`billing.billing_account`);
     - fails (non-zero exit, `ERROR PLATFORM_CHECK_FAILED <reason>`) unless the user is `reporting_runtime`, read-only is `on`, and isolation is `repeatable read`;
     - writes `platform_check_<yyyyMMddHHmmss>.txt` (those three values and the row count) to the task's working directory, publishes it as a Kestra output file, and delivers it to `/data/outbound/_platform-check/` by writing `.platform_check_<ts>.txt.tmp` then renaming;
     - logs the `DELIVERED` line and emits `status` = `WARNING` when `simulate_warning`, else `SUCCESS`.
  2. `set_status`: `io.kestra.plugin.core.flow.If` on `{{ outputs.check.vars.status == 'WARNING' }}` → `io.kestra.plugin.core.execution.Exit` with `state: WARNING`.
- **Labels:** `report=platform_check`, `flow_revision={{ flow.revision }}`.
- **The WARNING contract for every report (fixes `code-standards` §2.6):** exit 0 means the runtime finished (SUCCESS or WARNING); any non-zero exit is FAILED. WARNING is never an exit code; it's the `status` output plus the `Exit` task. If the pinned engine doesn't support `Exit` with `state: WARNING`, the implementer stops and raises it (no workaround in the unit). The verified mechanism is written into `flows/reporting/README.md` for rpt02 onward.

### D9 — What rpt01 does not do

No report flow, no column definition, no namespace-file deploy, no `report-validate-*` subflow (rpt02); no pgledger, rating or GL grants (rpt03, rpt08, rpt09); no app code, no engine-registry entry (RF5); no reader access to the outbound account; no schedule.

---

## Implementation

1. **`db/bootstrap/reporting-db-roles.sql` (new):** Steps 0–6 as D1/D2. Step 0 precondition; Step 1 role (drift-safe); Step 2 `default_transaction_read_only`; Step 3 `CONNECT`; Step 4 schema `USAGE`; Step 5 table `SELECT`; Step 6 explicit `REVOKE`s. `--> statement-breakpoint` between statements, as billrun.
2. **`db/bootstrap/reporting-db-roles.ts` (new):** the same runner shape as `billrun-db-roles.ts`.
3. **`package.json`:** `"db:bootstrap-reporting-roles": "node --env-file=.env --import tsx db/bootstrap/reporting-db-roles.ts"`.
4. **`infra/docs/db-role-verification.md`:** step 3c (run order, the manual password, the verification queries).
5. **Local dev provisioning:** wherever the dev stack runs the role bootstraps and sets local passwords (the `.env.example` / setup script used for `billrun_runtime`), add `reporting_runtime` with a local-only password.
6. **Runtime:** `runtime/reporting/{__init__,common/__init__,common/db,common/trace,platform_check/__init__,platform_check/__main__}.py` (D4, D8). No new library: `psycopg` and `hashlib` are already available.
7. **Flow:** `flows/reporting/report-platform-check.yaml` and `flows/reporting/README.md` (D5, D7, D8).
8. **READMEs:** `flows/README.md`, `workflow-management/README.md`, `runtime/README.md` (D5).
9. **Dev compose:** `flow-deploy` map line; the engine's `/data/outbound` bind mount; `dev/outbound/{README.md,.gitignore}`; the `REPORTING_DB_*` vars and `SECRET_REPORTING_RUNTIME_PASSWORD` in `dev/.env.example` (local value only).
10. **Bicep:** `modules/reporting-outbound-storage.bicep` (new); `main.bicep` parameters `enableReporting`, `reportingOutboundStorageAccountName`, `reportingOutboundEnvStorageName`; `workflow-engine-container-app.bicep` volume, mount, env vars and secret (D7); the per-environment parameter files set `enableReporting` where billrun is hosted.
11. **CI:** `deploy_workflow_flows` gains `reporting` (D6).

## Tests

**Where tests live (all reporting units):** vitest suites in `tests/reporting/`, following the rating pattern. Tests that exercise Python run the runtime as a subprocess by absolute `python3` path, as `tests/helpers/rating-ran-harness.ts` does; rpt01 adds `tests/helpers/reporting-harness.ts` for that. "Worker unit test" below means such a suite with no database.

| # | Test | Where | Expected |
|---|---|---|---|
| R01-T1 | Role attributes | `tests/db/reporting-db-roles.integration.test.ts` (new, live DB) | `reporting_runtime` exists with `LOGIN`, no superuser/createrole/createdb/replication/bypassrls, connection limit 10, `default_transaction_read_only = on` |
| R01-T2 | Reads | same | `SELECT` succeeds on each of the nine D2 tables |
| R01-T3 | Writes refused | same | `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE` on each of the nine tables raise `permission denied` (with read-only turned off for the session, so the grant, not the setting, is what refuses) — **guardrail 1** |
| R01-T4 | No other access | same | `SELECT` on a non-granted table (e.g. `billing.gl_mapping`, `rating.udr_rated`) refused; `EXECUTE` on `billing.pgledger_create_transfer` refused; `CONNECT` to `kestra` refused |
| R01-T5 | No broad grants | same | `information_schema.role_table_grants` for `reporting_runtime` lists exactly the nine tables, `SELECT` only; no default privileges exist for the role |
| R01-T6 | Ordering precondition | same | with `PUBLIC` `CONNECT` restored on a scratch database, the script fails with `ORDERING:` and creates nothing |
| R01-T7 | Drift | same | a role made a member of another role makes the script fail with `DRIFT:` |
| R01-T8 | Idempotent | same | running the script twice leaves identical grants |
| R01-T9 | `common/db.py` | worker unit test | refuses to connect without the secret; the first statement in a snapshot is the `SET TRANSACTION … REPEATABLE READ READ ONLY`; the DSN never appears in logs or exceptions |
| R01-T10 | `common/trace.py` | worker unit test | `DELIVERED` line format and SHA-256 match a fixture file |
| R01-T11 | Check flow, SUCCESS | local Kestra (manual + scripted) | run ends **SUCCESS**; output file present; the same file in `dev/outbound/_platform-check/`; no `.tmp` left; `DELIVERED` line hash equals the file's; labels `report` and `flow_revision` set |
| R01-T12 | Check flow, WARNING | local Kestra | with `simulate_warning=true`, run ends **WARNING** through the `Exit` task |
| R01-T13 | Check flow, FAILED | local Kestra | with `SECRET_REPORTING_RUNTIME_PASSWORD` unset, run ends **FAILED** and nothing lands in `_platform-check/` |
| R01-T14 | Deploy | dev `flow-deploy`, CI stage | `reporting` namespace exists with `report-platform-check`; re-running deploy changes nothing |
| R01-T15 | Bicep | `az bicep build` + what-if | the outbound account has secure transfer on, SMB 3.1.1 and AES-256-GCM only, no public blob access; it is a different account from the engine's; the mount exists only when `enableReporting` |

## Dependencies

- Platform, rating and billrun role bootstraps already applied in every environment (D1 order).
- The engine image at `v1.3.35` with the `Process` runner and `runtime/` on its Python path (existing).
- Key Vault secret `reporting-runtime-db-password` created per environment before the engine deploy with `enableReporting: true`.

## Docs to sync in the same change set

- `rptmgmt-code-standards.md`: §2.6 (WARNING contract, D8), §7 (pgledger moves to rpt03), §8 (`common/db.py`, `common/trace.py`, `platform_check/`, `report-platform-check.yaml`).
- `rptmgmt-architecture.md` §4: outbound credential = a separate account's key via the platform mount; no Basic-Auth credential.
- `rptmgmt-progress-tracker.md`, `specs/rpt00-build-plan.md` status.
- The codebase's `context/` copies are refreshed from the planning repo when the unit is built.

## Verification checklist

1. R01-T1–T15 pass; R01-T1–T8 against a live database.
2. `tsc --noEmit`, lint and Prettier green for the `.ts` runner; Python lint and unit tests green; the flow parses and deploys.
3. No app code, migration, or other module's role file changed.
4. No secret value in any committed file; `dev/.env.example` carries a local-only placeholder.
5. Docs synced (above); the WARNING mechanism recorded in `flows/reporting/README.md`.
