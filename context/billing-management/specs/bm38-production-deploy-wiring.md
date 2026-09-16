# bm38 — Production Deployable + Wired

**Unit:** bm38 (Phase 4 · Phase O). **Boundary:** infra — `infra/bicep/modules/workflow-engine-container-app.bicep`, `infra/bicep/main.bicep`, `infra/bicep/parameters/prod.bicepparam`, `infra/azure-pipelines.yml`, `infra/docs/db-role-verification.md` — plus the flow template docs (`bill_run_processing.template.yml`, `bill-run-*/README.md`). **No app code, no schema, no migration.** **Specs from:** `billmgmt-update-overview.md` (Phase 4 goal 6; "deployable + wired" done-ness; promote-local-dev-flow decision), `billmgmt-gap-assessment.md` (§5 Category B, §6.3), `billmgmt-progress-tracker.md` (Outstanding / prod-deploy note), `bm00-build-plan.md` Unit 38.

> **Framing.** Production is closer than the gap-assessment's "the bicep hasn't shipped" implied: the shared `workflow-engine` Container App bicep already exists and — in prod's `collapsed` topology — hosts the `billrun` namespace; `deploy_workflow_flows` already pushes `bill-run-processor/local-dev` and `bill-run-distributor/local-dev` to it; the SFTP wiring is fully parameterised. What is genuinely missing is **secret wiring + gated flags + doc truth**: the `billrun_runtime` DB URL has no Key Vault secret or consumer mapping; `billrun-engine-url`/`-auth` are flagged NOT-YET-CREATED; the deploy flags are off by default; and the `template.yml` still claims a separate, TBD-owned canonical flow that does not exist. This unit makes the deploy path deployable-and-reviewable. **The actual cloud cutover — flipping the flags and running the live smoke against a real engine + SFTP — is a later gated ops step, not this unit.**

## Goal

Wire the `billrun_runtime` DB credential and the engine/SFTP Key Vault secrets and their consumer mapping into the shared `workflow-engine` bicep, ready (still-gated) the deploy flags, promote the `local-dev` flow as the production flow and correct the template "separate repo, TBD owner" fiction, and record the taxation-`0.00` interim plus the production cutover runbook — so the prod deploy path is deployable and reviewable with cutover gated.

## Design

**Structural decisions**

- **No new container — the `billrun` namespace rides the shared engine (collapsed topology).** `prod.bicepparam` sets `topology = 'collapsed'`; one `workflow-engine` Container App hosts both `rating` and `billrun`. This unit adds credentials/secrets to that module, not a new Container App/Job.
- **`billrun_runtime` DB URL becomes a first-class Key Vault secret + engine env var.** The flows connect to Postgres as `billrun_runtime` (bm14). Add a Key Vault secret `billrun-runtime-db-url`, a `secretRef` on the engine container, and env `BILLRUN_RUNTIME_DATABASE_URL` — closing the gap `db-role-verification.md` flags ("no Key Vault secret name or consumer mapping defined yet"). Gate the wiring behind a param so a `billrun`-hosting engine gets it and a rating-only engine does not.
- **App→engine credential secrets, created not assumed.** Create `billrun-engine-url` and `billrun-engine-auth` (flagged NOT-YET-CREATED in `azure-pipelines.yml`). `billrun-engine-auth` is a **coupled triple** — its username half must be `workflow-ops@billing.ops` to match the engine's Basic-Auth user and the `deploy_workflow_flows` `--user`; the cutover runbook makes the rotation explicit or every app→engine call 401s.
- **SFTP secrets stay parameter-gated (bm34 already wired the shape).** `enableSftpDistribution` + `sftp-private-key`/`sftp-known-hosts` already exist; document provisioning them and flip `enableSftpDistribution`/`distributionTargets='sftp'` **only when a real SFTP endpoint exists** (gated, default off — loopback stays the default).
- **Deploy flags readied but left gated.** `deployWorkflowEngine` (false), `deployRatingFlows` (gates `deploy_workflow_flows`), `runBillrunLiveKestraSmoke` (false) stay off; the runbook documents the cutover order. "Done" for this unit is deployable + wired + local E2E green (bm37) — not a green cloud run.
- **Promote the `local-dev` flow; delete the fiction.** The `local-dev` flow is what `flow-deploy` and `deploy_workflow_flows` push and is the flow bm36 gave signal-back. Correct `bill_run_processing.template.yml` and the `bill-run-*/README.md` `_TBD_` repo/owner/deploy-step lines to state the deployed flow **is** the versioned `local-dev` flow in this repo (no separate workflow-management repo).
- **Provisioning hygiene folded in (not a separate unit).** Record the `billrun_runtime` password step (`ALTER ROLE billrun_runtime WITH PASSWORD …`, URI-safe) and the "re-run `db:bootstrap-billrun-roles` after pulling grant-file changes" note in the runbook; bm23 already added the `app_runtime`/`billrun_runtime` `customer_bill_line` grants, so no SQL change is needed here.

## Implementation

### 1. `billrun_runtime` DB credential secret + consumer mapping

> **Review correction (implemented shape supersedes this section).** This section
> — inherited from bm14's `.env.example` wording — assumed a full-URL secret
> `billrun-runtime-db-url` / env `BILLRUN_RUNTIME_DATABASE_URL`. A code review
> found that **no code or flow consumes that variable**: the deployed
> `bill_run_processing.yml` connects with the same split shape as the rating
> worker — a bare password via `PGPASSWORD=${SECRET_BILLRUN_RUNTIME_PASSWORD}`
> plus `BILLRUN_DB_HOST/PORT/NAME/USER` — so a full-URL wiring is inert (the
> flow hard-aborts on the unset `SECRET_BILLRUN_RUNTIME_PASSWORD`). As shipped,
> the wiring is therefore the **split shape**, and the orphaned
> `BILLRUN_RUNTIME_DATABASE_URL` was removed from `.env.example`. Read the bullets
> below with `billrun-runtime-db-url` → `billrun-runtime-db-password` (bare
> password) and `BILLRUN_RUNTIME_DATABASE_URL` → `SECRET_BILLRUN_RUNTIME_PASSWORD`
> + `BILLRUN_DB_*`. The goal (gate the credential onto the billrun-hosting engine)
> is unchanged.

- **Key Vault:** new secret `billrun-runtime-db-url` (the `postgresql://billrun_runtime:<pwd>@<host>/<db>` URL; value provisioned out-of-band, never in git).
- **`workflow-engine-container-app.bicep`:** a `billrun-runtime-db-url` entry in the `secrets` block and a `BILLRUN_RUNTIME_DATABASE_URL` env var (`secretRef`), gated by a new param (e.g. `hostsBillrunNamespace`, true when `defaultNamespace == 'billrun'` / collapsed).
- **`db-role-verification.md` §2:** replace the "not yet wired" note with the secret name (`billrun-runtime-db-url`) and consumer mapping (the `workflow-engine` container).

### 2. App→engine + SFTP secrets

- Create `billrun-engine-url` / `billrun-engine-auth` in Key Vault (consumed by `deploy_workflow_flows` and the `billrun_live_kestra_smoke` stage, which already reference them); remove the NOT-YET-CREATED flag comment once created.
- Document provisioning `sftp-private-key` / `sftp-known-hosts` and the `enableSftpDistribution` flip for the eventual SFTP cutover (gated; loopback default).

### 3. Deploy flags + pipeline

- Keep `deployWorkflowEngine`, `deployRatingFlows`, `runBillrunLiveKestraSmoke` off by default in `main.bicep`/pipeline; confirm `deploy_workflow_flows` maps `bill-run-processor/local-dev → billrun` and `bill-run-distributor/local-dev → billrun`; document the cutover order in the runbook (deploy engine → provision secrets → deploy flows → run smoke → flip SFTP if used).

### 4. Promote the flow + correct docs

- `bill_run_processing.template.yml` + `bill-run-*/README.md`: state the deployed flow is the repo's `local-dev` flow; drop the `_TBD_` separate-repo/owner/deploy-step framing.
- **`billmgmt-architecture.md` (doc sync, B):** correct any deployment/topology framing that implies a separate processor deployment or a separate flow repo — the `billrun` namespace rides the shared `workflow-engine` Container App (collapsed topology, **no** separate processor/distributor container), and the deployed flow is the repo's `local-dev` flow.

### 5. Cutover runbook + taxation decision

- Add a "Production cutover" section (order of operations; the `billrun-engine-auth` username = `workflow-ops@billing.ops` rotation; `billrun_runtime` `ALTER ROLE` password step; re-run `db:bootstrap-billrun-roles` after grant-file pulls) and record the taxation-`0.00` interim explicitly (already reflected in `billmgmt-known-issues.md` §10 and the flow's no-op `taxation` stage).

## Dependencies

- **No new npm packages.** Azure Key Vault + Bicep + Azure DevOps pipeline (existing stack).
- **Prerequisites:** bm14 (`billrun_runtime` role); bm36 (the signal-back flow that gets promoted/deployed); the existing `workflow-engine` bicep module, `deploy_workflow_flows` stage, and `billrun_live_kestra_smoke` stage.

## Verification checklist

- [ ] `workflow-engine-container-app.bicep` declares a `billrun-runtime-db-url` secret + a `BILLRUN_RUNTIME_DATABASE_URL` env `secretRef`, gated to the `billrun`-hosting engine; a bicep build (`az bicep build` / `what-if`) is clean.
- [ ] `db-role-verification.md` §2 names the `billrun-runtime-db-url` secret and its consumer (the engine container), superseding the "not yet wired" note; the `ALTER ROLE billrun_runtime` password step is recorded.
- [ ] `billrun-engine-url` / `billrun-engine-auth` are created (or documented as a named cutover prerequisite), with the `billrun-engine-auth` username = `workflow-ops@billing.ops` rotation called out; the NOT-YET-CREATED flag is resolved.
- [ ] `deployWorkflowEngine` / `deployRatingFlows` / `runBillrunLiveKestraSmoke` remain **off by default**; `deploy_workflow_flows` still maps `bill-run-processor/local-dev` and `bill-run-distributor/local-dev` to the `billrun` namespace; the cutover runbook documents the order.
- [ ] `bill_run_processing.template.yml` and the `bill-run-*/README.md` no longer claim a separate, TBD-owned canonical flow — the repo's `local-dev` flow is named as the deployed flow.
- [ ] The taxation-`0.00` interim is recorded; **no new migration or schema** is introduced by this unit; `billmgmt-progress-tracker.md` records bm38.
- [ ] **Doc sync (B):** `billmgmt-architecture.md` no longer implies a separate processor deployment or flow repo — it states the collapsed-topology shared engine hosts the `billrun` namespace and the `local-dev` flow is the deployed flow.
