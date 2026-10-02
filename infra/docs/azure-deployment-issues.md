# Azure Deployment — App Issue Register

App-side problems (DB bootstrap, migrations, seeds, workflow engine runtime) that
must be fixed for a **clean, from-scratch Azure deployment** to work without manual
patching. Each entry gives the symptom, the root cause, the current workaround,
and the fix still owed.

Infra problems found at the same time were fixed in place (bicep, Dockerfile,
runbook) and are listed at the end for traceability.

> **No real identifiers in this file.** Use placeholders (`$RG`, `<kv-name>`, …).
> The repo is being prepared for open source. The runbook is
> [environment-operations.md](environment-operations.md).

**Severity:** High = a page or service fails on a clean deploy · Medium = a
manual step is needed every time · Low = cosmetic.

_Opened 2026-09-25, from the first Azure dev stand-up._

---

## Summary

| ID | Area | Issue | Sev | Workaround today |
|---|---|---|---|---|
| [APP-01](#app-01) | DB roles | Bill-run `billing` tables missing from the role bootstrap grants | High | Manual GRANT (runbook §5e) |
| [APP-02](#app-02) | DB roles / migrations | Initial migrate runs as server admin, so `app_migrate` owns nothing | High | None — the migrate job will fail on first ALTER |
| [APP-03](#app-03) | Migrations | Applied migrations edited in place → silent schema drift | High | Hand-rebuild of the affected schema |
| [APP-04](#app-04) | Seeds | No single command seeds a target environment | Medium | Seed loop in runbook §5h |
| [APP-05](#app-05) | Bill run ↔ engine | App↔engine fully wired + flows deployed on Azure dev (both directions, incl. blob artifacts) | High | Resolved on dev 2026-09-28 |
| [APP-06](#app-06) | Workflow engine | Blob storage, landing mount and flows unverified on ACA | Medium | None |
| [APP-07](#app-07) | Workflow engine | `SECRET_*` plain passwords log base64 decode errors | Low | Ignore the log lines |

---

### APP-01

**Bill-run `billing` tables missing from the role bootstrap grants** · High

- **Symptom:** Bill Run pages fail with `permission denied for table bill_run`
  (42501); `materializeDueRuns` can't insert due runs.
- **Root cause:** `db/bootstrap/bootstrap-db-roles.sql` grants `billing` tables to
  `app_runtime` per table (the ten account-module tables) and relies on
  `ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate` for anything later. Those
  default privileges never fire (see APP-02), and the bill-run tables aren't in
  the explicit list: `bill_run`, `bill_run_account`, `bill_run_account_stage`,
  `bill_run_distribution`, `bill_run_invoices`, `customer_bill`. Local
  from-scratch setups hit the same gap.
- **Workaround:** manual GRANT on the six parent tables, documented as a
  follow-up in runbook §5e (applied on Azure dev 2026-09-25).
- **Fix:** add the six explicit grants to `bootstrap-db-roles.sql` (or
  `billrun-db-roles.sql`), keeping `customer_bill_tax_item` SELECT-only
  (`billrun_runtime` is its sole writer) and `pgledger_*` ungranted. Then remove
  the manual step from the runbook. Add an integration test asserting
  `app_runtime` can read every `billing` table except the pgledger ones.

### APP-02

**Initial migrate runs as server admin, so `app_migrate` owns nothing** · High

- **Symptom:** every table in every app schema is owned by the Postgres admin
  login. Not yet a visible failure, because the migrate job has never run.
- **Root cause:** `db/bootstrap/*-db-roles.sql` needs the schemas to exist, so the
  runbook runs `db/migrate.ts` as the admin first (§5d), then creates the roles
  (§5e). `ebill-dev-migrate-job` connects as `app_migrate`, which gets table
  **privileges** but not **ownership**, and `ALTER TABLE`, `DROP` and
  `CREATE INDEX ON` all require ownership. The same ordering is why
  `ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate` never takes effect (APP-01).
- **Impact:** the first migration after go-live that alters an existing table is
  expected to fail with `must be owner of table …`. Until then, migrations can
  only be run by hand from a workstation, with no guarantee that they match the
  deployed image (which is how APP-03 reached Azure).
- **Fix (decision needed):**
  1. **Preferred:** split role creation from the per-schema grants. Create
     `app_migrate` first, grant it `CREATE` on the database, run the initial
     migrate **as `app_migrate`** (via the migrate job, with the same image tag as
     the app), then apply the grants. `app_migrate` owns everything and the
     default privileges work as designed.
  2. **Alternative:** after the bootstrap, transfer ownership per app schema
     (`ALTER TABLE/SEQUENCE/FUNCTION/TYPE … OWNER TO app_migrate`). Avoid
     `REASSIGN OWNED BY <admin>`, which would also move non-app objects such as
     the partman and cron setup.

  Either way, prove it with a no-op migration through the migrate job.

### APP-03

**Applied migrations edited in place → silent schema drift** · High

- **Symptom:** product pages fail with `column "price_component" does not exist`
  (42703). Earlier, `product.lifecycle_status` was missing `TESTING` and
  `OBSOLETE`.
- **Root cause:** `0006_product.sql` and `0007_product_constraints_fix.sql` were
  rewritten in place (pm35, pm46–pm49) instead of getting forward migrations.
  Drizzle skips any migration already recorded in `drizzle.__drizzle_migrations`
  and still reports success, so a database migrated before the edits keeps the
  old shape. Azure dev had the 2026-08-10 versions.
- **Workaround (Azure dev, 2026-09-25):** rebuilt only the `product` schema in one
  transaction: drop CASCADE; re-apply the current 0006 (minus its `permissions`
  insert), 0007, 0010 and 0040; re-add the two foreign keys from
  `ordering.product_order_item` and `inventory.product_inventory`; re-grant; update
  the two recorded hashes. All 41 hashes now match.
- **Fix:**
  - Policy (code standards): a migration is immutable once merged; changes go in
    a new forward migration.
  - Add a drift check that compares sha256 of each `meta/_journal.json` entry's
    `.sql` with `drizzle.__drizzle_migrations.hash`. Run it in CI against a
    freshly migrated DB and in `db/migrate.ts` / the migrate job, failing on any
    mismatch.
  - Every database migrated before pm35 (developer local DBs, the `dev1`
    environment) still needs a forward migration for the 0006/0007 changes, or a
    rebuild.

### APP-04

**No single command seeds a target environment** · Medium

- **Symptom:** after the admin and RBAC seeds, only the admin pages appear.
  Products, Customers, Accounts and Billing are hidden, and the accounts wizard
  logs `one or more accounts config rows are missing — run db:seed-accounts`.
- **Root cause:** permissions and reference data are spread across eight seed
  scripts. `npm run db:setup` runs them in order, but it also migrates and
  hard-codes `--env-file=.env`, so it can't target Azure. Each `db:seed-*` script
  hard-codes `.env` too.
- **Workaround:** runbook §5h loops over all eight seeds with
  `--env-file=.env.azure.dev`. The list is a manual copy of `db:setup`, so the two
  can drift apart.
- **Fix:** add a `db:seed-all` entry point (e.g. `db/seeds/seed-all.ts`) that runs
  the eight in order, and parameterise the env file (e.g.
  `ENV_FILE=.env.azure.dev npm run db:seed-all`). Make `db:setup` and the
  runbook both call it.

### APP-05

**App not connected to Kestra on Azure (stub client in use)** · High

- **Symptom:** Bill Run pages load, but triggering a run never reaches the
  engine. With no `BILLRUN_ENGINE_URL` / `BILLRUN_ENGINE_AUTH`, `lib/config.ts`
  selects the stub engine client.
- **Root cause (several parts):**
  - `container-app.bicep` doesn't set `BILLRUN_ENGINE_URL`,
    `BILLRUN_ENGINE_AUTH` or `BILLRUN_APP_TOKEN` (the engine→app callback token).
    The pipeline treats `billrun-engine-url` / `billrun-engine-auth` as named
    cutover prerequisites.
  - The engine has no ingress. `internalIngress` defaults to false and external
    ingress is gated behind rm05 Easy Auth (D8).
  - No rating or bill-run flows are deployed to the Azure engine.
  - The username half of `billrun-engine-auth` must equal
    `KESTRA_SERVER_BASIC_AUTH_USERNAME` (see the coupled-identity note in
    `workflow-engine-container-app.bicep`).
- **Fix (decision needed):**
  - Choose the dev access path: environment-internal ingress (reachable only
    inside the VNet or over the VPN, Basic Auth) or rm05 Easy Auth.
  - Then wire the three env vars through Key Vault secret refs in
    `container-app.bicep` (HTTPS internal FQDN, per the config rule).
  - Deploy the flows (pipeline `deploy_workflow_flows`), and confirm a trigger
    gets a real execution id end to end.

- **Progress (Azure dev, 2026-09-28) — app↔engine now connected:**
  - **Access path chosen:** plain external ingress on the *internal* Container
    Apps Environment (VPN-only, no Easy Auth). The env is already `internal:
    true`, so `ingress.external: true` is not public — it's the same pattern the
    `app` container uses, and it's the only one whose FQDN
    (`ebill-dev-workflow-engine.<defaultDomain>`) is covered by the environment's
    wildcard private-DNS record *and* its managed TLS cert. The engine's
    `.internal.<...>` FQDN is covered by neither, which would break the app's
    HTTPS-only engine client. Verified live: engine API `401` unauth / `200`
    authed, UI `200`, `ssl_verify_result=0`.
  - **Bicep (committed source):** `workflow-engine-container-app.bicep` gains an
    `exposeInternalEnvIngress` param (external ingress, no Easy Auth) + a
    `workflowEngineFqdn` output + `SECRET_BILLRUN_APP_TOKEN` / `billrun-app-token-b64`
    wiring under `hostsBillrunNamespace`; `main.bicep` sets
    `exposeInternalEnvIngress: !empty(acaSubnetId)` and derives the app's
    `BILLRUN_ENGINE_URL` from the engine FQDN; `container-app.bicep` gains a
    `billRunEngineUrl` param that (when set) emits `BILLRUN_ENGINE_URL` +
    `BILLRUN_ENGINE_AUTH` + `BILLRUN_APP_TOKEN` and references the
    `billrun-engine-auth` / `billrun-app-token` KV secrets. `az bicep build`
    clean. A `main.bicepparam` redeploy reproduces the live state.
  - **Key Vault secrets seeded:** `billrun-engine-auth`
    (`workflow-ops@billing.ops:<kestra-basic-auth-password>`), `billrun-app-token`
    (plain M2M bearer, ≥32 chars), `billrun-app-token-b64` (base64 of the same
    token, for the engine's `SECRET_` env-secret backend). The base64 secret
    decodes to the plain one, so the flow's `{{ secret('BILLRUN_APP_TOKEN') }}`
    bearer will match the app's `BILLRUN_APP_TOKEN` validator.
  - **Live patches applied (CLI):** engine ingress enabled (external, :8080);
    app secrets `billrun-engine-auth` + `billrun-app-token` (KV refs, app MI) and
    env `BILLRUN_ENGINE_URL`/`_AUTH`/`BILLRUN_APP_TOKEN` (app rev `--0000003`,
    Healthy); engine secret `billrun-app-token-b64` + env `SECRET_BILLRUN_APP_TOKEN`
    (engine rev `--0000009`, Healthy). App now selects the REAL engine client.
  - **Engine→app callback — RESOLVED (2026-09-28).** The processor/distributor
    flows' callback host is now parameterized: `http://app:3000` →
    `{{ envs.billrun_app_base_url | default('http://app:3000') }}` (10 URIs across
    `bill_run_processing.yml` + `bill_run_distribution.yml`). Kestra v0.23+
    autoloads `ENV_`-prefixed env vars into `{{ envs.* }}`, so the deployed engine
    sets `ENV_BILLRUN_APP_BASE_URL` to the app's HTTPS URL
    (`billrunAppBaseUrl` param → `workflow-engine-container-app.bicep`); local dev
    leaves it unset and the flow defaults to `http://app:3000` (the compose
    `extra_hosts: app:host-gateway` trick still applies to the default, so local
    runtime is byte-identical). Flows are DEPLOYED to the Azure `billrun`
    namespace — done here directly via the Kestra API over the VPN (the engine now
    has reachable ingress), which sidesteps the `deploy_workflow_flows`
    hosted-agent reachability problem for a manual dev deploy; the pipeline path
    is still owed for CI. Verified: deployed flow shows the templated URI;
    engine→app callback with the bearer returns 422 "Invalid run id" (token
    accepted), without it 401 (fail-closed).
  - **Distribution blob artifacts — RESOLVED (2026-09-28).** The invoice/report
    artifact store is now wired end-to-end on the SAME storage account the engine
    already uses (`…ratingstg…`), container `invoices`:
    - **App (writes, bm19):** `enableBlobArtifacts` (`container-app.bicep`) emits
      `BILLRUN_BLOB_CONNECTION_STRING` from the `billrun-blob-connection-string` KV
      secret. `blob-store.ts` auto-creates the container on this connection-string
      path (also pre-created here).
    - **Engine (reads, bm34):** `enableBlobArtifactAccess`
      (`workflow-engine-container-app.bicep`) emits `ENV_BILLRUN_BLOB_ENDPOINT`
      (derived from `storageAccountName`, like `KESTRA_STORAGE_AZURE_ENDPOINT`) +
      `SECRET_AZURE_STORAGE_CONNECTION_STRING` from the base64
      `billrun-blob-connection-string-b64` KV secret.
    - **Flow:** the distributor's hardcoded Azurite `endpoint:` is parameterized
      `{{ envs.billrun_blob_endpoint | default('http://azurite:10000/devstoreaccount1') }}`
      (local dev keeps Azurite via the default; the deployed engine sets the real
      endpoint). Both app + engine derive from ONE `main.bicep` knob
      (`enableBlobArtifacts`, true in `dev.bicepparam`) so they can't split-brain.
    - **Prereq:** shared-key access must be enabled on the account (it is —
      `allowSharedKeyAccess` default true). Verified: both revisions Healthy, the
      base64 secret decodes to the app's plain connection string, distributor flow
      redeployed with the parameterized endpoint.
    - **Deferred (prod hardening):** prod should prefer `BILLRUN_BLOB_ACCOUNT_URL`
      + Managed Identity for the app (Kestra's Download task would need its MI-auth
      fields) instead of a shared-key connection string. The connection-string path
      here matches local dev and is the dev-appropriate choice.
  - **VPN operator UI access:** browse the engine UI at
    `https://ebill-dev-workflow-engine.<defaultDomain>/ui/` over the VPN. If the
    private-DNS zone isn't pushed to the VPN client, add a hosts-file entry
    `10.20.0.14 ebill-dev-workflow-engine.<defaultDomain>` (same pattern as the
    app, runbook §6e).

### APP-06

**Blob storage, landing mount and flows unverified on ACA** · Medium

- **Status:** the engine now starts and runs its worker, executor and scheduler
  on the `kestra` DB. The remaining D0 process-runner spike items are unproven on
  ACA:
  - Kestra internal storage on Azure Blob via Managed Identity (`KESTRA_STORAGE_*`;
    the module flags MI support as unconfirmed);
  - the Azure Files `landing` mount at `/data/landing`;
  - the loopback `/distribution` share;
  - that `kestra-basic-auth-password` passes Kestra's password policy.
- **Fix:** run the D0 checks on dev: a flow that writes and reads internal
  storage, lists the landing share, and writes to `/distribution`; plus a Basic
  Auth login. Record the results in the module header and the rating/billing
  progress trackers. If MI isn't supported, switch to a SAS / connection-string
  Key Vault secret (D5's credential count changes).

### APP-07

**`SECRET_*` plain passwords log base64 decode errors** · Low

- **Symptom:** on every engine start, `Could not decode secret
  'SECRET_RATING_RUNTIME_PASSWORD'` / `'SECRET_BILLRUN_RUNTIME_PASSWORD'` appears
  at ERROR level. It looks like a failure and hides real errors.
- **Root cause:** Kestra's OSS env secret backend base64-decodes every `SECRET_*`
  variable. These two hold raw passwords read straight from the environment by
  `workflow-management/worker/workflow-engine/runtime/db.py` and the bill-run
  flows' shell tasks, never through `{{ secret() }}`.
- **Fix:** rename them without the `SECRET_` prefix (e.g.
  `RATING_RUNTIME_DB_PASSWORD`, `BILLRUN_RUNTIME_DB_PASSWORD`) in `runtime/db.py`,
  the bill-run flows, the local dev compose env and
  `workflow-engine-container-app.bicep`, all in one change.

---

## Infra fixed in place (2026-09-25) — for traceability

These were repo fixes, not app work. The live dev environment already carries
the equivalent CLI patches, and a `what-if` against dev confirms a redeploy keeps
them.

| Problem | Fix | Where |
|---|---|---|
| Kestra exits printing help (no startup subcommand) | `CMD ["server","standalone"]`; `args` set in bicep so it doesn't depend on the image | `workflow-management/worker/workflow-engine/Dockerfile`, `modules/workflow-engine-container-app.bicep` |
| Kestra crash: `kestra.repository.type` missing, then `datasources.default` not found | Added `KESTRA_REPOSITORY_TYPE` / `KESTRA_QUEUE_TYPE`; renamed `KESTRA_DATASOURCES_POSTGRES_*` → `DATASOURCES_POSTGRES_*` | `modules/workflow-engine-container-app.bicep` |
| CPU/memory only set by CLI; a redeploy reverted to 0.5 vCPU / 1 GiB | `appCpu/appMemory/workflowEngineCpu/workflowEngineMemory` params (dev: 2 / 4Gi) | `main.bicep`, both app modules, `parameters/dev.bicepparam` |
| Phase 2 fails without SSO (`microsoft-client-secret` not in Key Vault) | Secret + env var only when `microsoftClientId` is set; placeholder step removed | `modules/container-app.bicep`, runbook §6d |
| App crash `Invalid URL`: `% # ! *` in DB passwords embedded in DSNs | Alphanumeric password generator; DSN passwords URL-encoded | runbook §5g, §6d |
| Runbook seeded only admin + RBAC | New §5h runs all eight seeds | runbook §5h |
| Bill Run 42501 on a fresh environment | Manual grant documented (until APP-01 lands) | runbook §5e |
| Migrations run from an arbitrary checkout | Warning + hash-check note (until APP-02/03 land) | runbook §5d |
| VPN clients can't resolve the app hostname | Scripted hosts-file entries | runbook §6e |
| Compiled bicep JSON committed with real subscription / SP / resource IDs | Untracked; `/infra/bicep/**/*.json` ignored | `.gitignore` |
| Real identifiers in the runbook and READMEs | Replaced with placeholders / derived values | runbook, `network/README.md`, `postgres/README.md`, `dev.bicepparam` |

**Infra still open (not app work, needs a decision):**
- **Private DNS for VPN clients.** The permanent fix is an Azure DNS Private
  Resolver inbound endpoint pushed as the P2S client DNS server. That is
  net-new infra with a cost and a production equivalent to agree.
- **Postgres `ServerIsBusy` on redeploy.** Transient; retry. Could be avoided by
  skipping the Postgres module on workload-only redeploys.
