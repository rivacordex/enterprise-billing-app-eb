# Spec: um30 — Deployment, Secrets & Security Gates

**Unit:** um30  
**Boundary:** INFRA  
**Dependencies:** All prior units (um1–um24)

---

## Goal

Ship the application to Azure Container Apps via a fully gated Azure DevOps pipeline that: runs migrations before traffic shifts, injects all secrets from Key Vault via Managed Identity, enforces a least-privilege DB role that cannot mutate audit rows, and blocks any build with a SAST or OWASP ZAP DAST high/critical finding.

---

## Design

### Pipeline shape

A single Azure DevOps multi-stage pipeline (`azure-pipelines.yml`) with five sequential, gated stages:

```
build → test+scan → containerize → migrate → deploy
```

- **build** — `tsc --noEmit`, ESLint, Zod validation smoke.
- **test+scan** — Jest unit + integration tests, then CodeQL SAST (already gating from um1). Stage fails and blocks on any high/critical SAST finding.
- **containerize** — `docker build`, push image to Azure Container Registry (ACR) tagged with the pipeline run ID and git SHA. No secrets baked into the image.
- **migrate** — runs `drizzle-kit migrate` as a one-shot Azure Container Apps Job using the new image, connecting via Key Vault-injected connection string. Traffic is still on the previous revision during this step. Stage fails and blocks if any migration exits non-zero.
- **deploy** — creates a new Container Apps revision (blue-green); traffic shifts only after migrations succeeded; old revision stays available for rollback. A post-deploy smoke test (HTTP 200 on `/api/health`) gates the traffic shift.

Promotion across environments (dev → staging → prod) is manual-approval gated at the deploy stage via Azure DevOps environment gates.

### Container image

Single `Dockerfile` at repo root. Multi-stage build:

1. **deps stage** — `node:22-alpine`, install production dependencies only (`npm ci --omit=dev`).
2. **builder stage** — install all deps, run `next build`.
3. **runner stage** — copy `.next/standalone` + `public` + `node_modules` from prior stages; run as a non-root user (`node`, UID 1000); expose port 3000; `ENTRYPOINT ["node", "server.js"]`.

No `.env` files, secrets, or DB URLs in any layer. All runtime config is injected as environment variables at Container Apps revision creation time, sourced from Key Vault references.

### Azure Container Apps revision config

- **Min replicas:** 2 (zone-spread across at least 2 AZs for HA).
- **Max replicas:** configurable per environment (e.g., 5 for prod).
- **Revision mode:** multiple (enables blue-green and instant rollback).
- **Traffic split:** new revision gets 0% on creation; pipeline shifts to 100% only after the post-deploy smoke test passes. Rollback = shift traffic back to previous revision via `az containerapp ingress traffic set`.
- **Scaling rule:** HTTP-concurrency KEDA rule (e.g., scale out at 50 concurrent requests per replica).
- **Liveness probe:** `GET /api/health`, 10 s initialDelay, 5 s period, 3 failures → restart.
- **Readiness probe:** same endpoint, 5 s period, 2 successes required before traffic.

### Secrets & Key Vault

All secrets flow through **Azure Key Vault + Managed Identity** — no secret ever lives in the repo, image, or pipeline variable group as plaintext.

| Secret                                     | Key Vault secret name          | Consumed as env var                 |
| ------------------------------------------ | ------------------------------ | ----------------------------------- |
| PostgreSQL connection string (app runtime) | `pg-connection-string-app`     | `DATABASE_URL`                      |
| PostgreSQL connection string (migrations)  | `pg-connection-string-migrate` | `DATABASE_URL` (migration job only) |
| Better-Auth secret                         | `better-auth-secret`           | `BETTER_AUTH_SECRET`                |
| Entra client secret                        | `entra-client-secret`          | `ENTRA_CLIENT_SECRET`               |

The app Managed Identity is granted **Key Vault Secrets User** on the vault (least-privilege — read secrets, no write/delete). The migration job uses a separate Managed Identity with the same vault access but a different connection string pointing at the migration DB role.

Container Apps secret references use the `keyvaultref:` URI form — the platform fetches and rotates them without a redeploy. Rotation procedure: update the Key Vault secret version → Container Apps picks it up on the next revision or can be forced via `az containerapp update`.

### Least-privilege DB role

Two Postgres roles are created by a **one-time bootstrap migration** (run once, never re-run):

**`app_runtime`** (used by the running application):

- `CONNECT` on the database.
- `USAGE` on schemas `core`, `product`, `customer`, `billing`, `accounting` (expand as modules ship).
- `SELECT`, `INSERT`, `UPDATE`, `DELETE` on all domain tables in those schemas (granted per table via a migration helper, or `GRANT ... ON ALL TABLES` with `ALTER DEFAULT PRIVILEGES` for future tables).
- **`INSERT` only on `core.AUDIT_LOG`** — explicitly no `UPDATE`, `DELETE`, `TRUNCATE`.
- No `CREATE`, `DROP`, `ALTER`, `TRUNCATE` on any object.
- No `GRANT OPTION`.

**`app_migrate`** (used by the migration job only):

- `CONNECT` on the database.
- `CREATE`, `ALTER`, `DROP` on schemas it owns (DDL rights for migrations).
- Full DML on all tables.
- `INSERT` on `core.AUDIT_LOG` (same constraint — even the migration role cannot delete audit rows).

The `DATABASE_URL` for the running app uses the `app_runtime` role credentials; the migration job's `DATABASE_URL` uses `app_migrate`. Both connection strings stored as separate Key Vault secrets.

### OWASP ZAP DAST stage

ZAP runs as a pipeline stage in CI against a **live ephemeral environment** (the freshly deployed dev/staging revision after the deploy stage, or a dedicated scan target). It does not run against production.

- **Mode:** ZAP Baseline Scan (automated, passive + active) using the official `owasp/zap2docker-stable` Docker image run as a pipeline task.
- **Target:** the Container Apps FQDN of the dev/staging revision, including authenticated pages. A ZAP context file (committed to `infra/zap/`) defines authentication (session cookie from a seeded test user), in-scope URLs, and any false-positive exclusions.
- **Gate:** ZAP exits non-zero on any **high or critical** finding → pipeline stage fails → the staging → prod promotion gate is blocked. Medium and below are reported as warnings but do not block.
- **Output:** ZAP HTML + JSON report published as a pipeline artifact on every run.
- **False positives:** managed via a ZAP `.conf` / `rules.tsv` file committed to `infra/zap/` with documented justifications per suppressed alert.

### Environment templates

`infra/env/` contains:

- `.env.example` — every required env var key with a placeholder value and a comment explaining what it is. **No real values.** Committed to the repo; this is the canonical list of env vars the app needs.
- `.env.dev.template`, `.env.staging.template`, `.env.prod.template` — environment-specific non-secret values (e.g., `NEXT_PUBLIC_APP_ENV=production`, `ENTRA_TENANT_ID`, derived redirect URIs). No secrets. These are used by the pipeline to construct the Container Apps environment variable list; secrets are added via Key Vault references, not these files.

`.env` (actual local secrets) is in `.gitignore` and never committed.

---

## Implementation

### 1. Dockerfile

**File:** `Dockerfile` (repo root)

- Stage 1 `deps`: `FROM node:22-alpine AS deps`. Copy `package.json`, `package-lock.json`. Run `npm ci --omit=dev`.
- Stage 2 `builder`: `FROM node:22-alpine AS builder`. Copy all source. Copy `node_modules` from deps. Run `npm ci` (all deps for build). Run `next build` (outputs `.next/standalone`).
- Stage 3 `runner`: `FROM node:22-alpine AS runner`. Set `NODE_ENV=production`. Create non-root user: `addgroup --system nodejs && adduser --system --ingroup nodejs nextjs`. Copy `.next/standalone`, `.next/static`, `public` from builder. Set `USER nextjs`. `EXPOSE 3000`. `ENV PORT 3000`. `ENTRYPOINT ["node", "server.js"]`.
- `.dockerignore`: exclude `.git`, `node_modules`, `.env*`, `infra/`, `tests/`, `*.md`, `.next` (let builder produce it).

### 2. Azure DevOps pipeline YAML

**File:** `infra/pipelines/azure-pipelines.yml`

Define five stages. Key details per stage:

**Stage: build**

- Pool: `ubuntu-latest`.
- Steps: `npm ci`, `npx tsc --noEmit`, `npx eslint . --max-warnings 0`.
- Caches `node_modules` by `package-lock.json` hash.

**Stage: test_scan** (depends on build)

- Steps: `npx jest --ci --coverage`, publish test results and coverage.
- CodeQL analysis step (already established in um1): `github/codeql-action` or the Azure DevOps CodeQL task. Language: `javascript`. Queries: `security-and-quality`. Fail on `high` or `critical` severity.
- If CodeQL or tests fail → stage fails, subsequent stages blocked.

**Stage: containerize** (depends on test_scan)

- Steps: `az acr build` or `docker build && docker push` to ACR. Tag: `$(Build.BuildId)-$(Build.SourceVersion:0:7)`.
- Store the image tag as a pipeline variable for downstream stages.

**Stage: migrate** (depends on containerize)

- Steps: `az containerapp job start` triggering the migration Container Apps Job (defined in IaC), using the new image tag. Wait for job completion (`az containerapp job execution show` polling loop, 5-minute timeout).
- Job runs `npx drizzle-kit migrate` with `DATABASE_URL` from Key Vault (`app_migrate` role). Exit code propagated — non-zero fails the stage.
- **No traffic shift happens during or before this stage.**

**Stage: deploy** (depends on migrate)

- Steps:
  1. `az containerapp update` — create new revision with the new image, 0% traffic, environment variables from template + Key Vault secret references.
  2. Run smoke test: `curl -f https://<fqdn>/api/health` (retry 3×, 5 s apart).
  3. On success: `az containerapp ingress traffic set` → new revision 100%, old revision 0%.
  4. On failure: leave old revision active (no traffic shift), fail the stage, alert.
- Environment approval gate (Azure DevOps Environments) for staging → prod promotion.

### 3. Infrastructure as Code (Bicep)

**Directory:** `infra/bicep/`

**Files:**

- `main.bicep` — orchestrates all modules, parameterized per environment.
- `modules/container-app.bicep` — Container Apps environment + app resource. Declares: min/max replicas, revision mode `multiple`, liveness + readiness probes, Key Vault secret references for `DATABASE_URL`, `BETTER_AUTH_SECRET`, `ENTRA_CLIENT_SECRET`. Managed Identity assigned.
- `modules/container-app-job.bicep` — migration job. Same image, `app_migrate` connection string from Key Vault, `replicaCompletionCount: 1`, `parallelism: 1`. Trigger: manual (invoked by pipeline).
- `modules/key-vault.bicep` — Key Vault with soft-delete enabled, purge protection enabled, `enabledForTemplateDeployment: false`. Access policy / RBAC: app MI → `Key Vault Secrets User`; migration MI → `Key Vault Secrets User`; pipeline service principal → `Key Vault Secrets Officer` (to write secrets during initial setup only).
- `modules/acr.bicep` — Azure Container Registry (Standard SKU), admin user disabled, ACR pull role assigned to app + migration MIs.
- `modules/postgres.bicep` — references the existing Flexible Server; declares the `app_runtime` and `app_migrate` Postgres roles via a post-provisioning script (or documented as a one-time step).
- `parameters/dev.bicepparam`, `staging.bicepparam`, `prod.bicepparam` — per-environment values (replica counts, SKUs, FQDN, etc.). No secrets in param files.

### 4. Least-privilege DB role bootstrap migration

**File:** `db/migrations/0000_bootstrap_db_roles.sql` (or Drizzle custom migration equivalent)

This migration is idempotent (`CREATE ROLE IF NOT EXISTS`) and runs once under a superuser/owner connection during initial provisioning (not via `app_migrate` — needs DDL rights on roles):

```sql
-- Create roles
CREATE ROLE app_runtime WITH LOGIN PASSWORD '<from Key Vault>';
CREATE ROLE app_migrate WITH LOGIN PASSWORD '<from Key Vault>';

-- Runtime role: domain DML + INSERT-only on AUDIT_LOG
GRANT CONNECT ON DATABASE <dbname> TO app_runtime;
GRANT USAGE ON SCHEMA core TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO app_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON core."AUDIT_LOG" FROM app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
-- Repeat GRANT/REVOKE pattern for each module schema as they are added.

-- Migration role: full DDL
GRANT CONNECT ON DATABASE <dbname> TO app_migrate;
GRANT CREATE ON DATABASE <dbname> TO app_migrate;
GRANT ALL ON SCHEMA core TO app_migrate;
ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT ALL ON TABLES TO app_migrate;
-- Repeat for each module schema.
-- AUDIT_LOG constraint: even app_migrate cannot delete audit rows
REVOKE UPDATE, DELETE, TRUNCATE ON core."AUDIT_LOG" FROM app_migrate;
```

The passwords for `app_runtime` and `app_migrate` are generated, stored in Key Vault as `pg-connection-string-app` and `pg-connection-string-migrate`, and never committed anywhere.

**Verification SQL** (run post-bootstrap, documented in `infra/docs/db-role-verification.md`):

```sql
-- Confirm app_runtime cannot delete from AUDIT_LOG
SET ROLE app_runtime;
DELETE FROM core."AUDIT_LOG" WHERE 1=0; -- must fail with permission denied
-- Confirm app_runtime cannot run DDL
CREATE TABLE core.test_forbidden (); -- must fail
```

### 5. OWASP ZAP DAST stage

**Files:**

- `infra/pipelines/zap-scan-stage.yml` — included by the main pipeline as a stage template (depends on deploy to dev/staging).
- `infra/zap/zap-context.xml` — ZAP context file defining: target URL (`https://<staging-fqdn>`), authentication method (form-based or cookie injection using a seeded test user), in-scope URL patterns (`/administration/**`, `/api/**`), out-of-scope (`/api/auth/callback/**` — Entra redirect, can't be ZAP-driven).
- `infra/zap/rules.tsv` — false-positive suppressions, each line: `<ruleId>\tIGNORE\t<justification>`.

**Pipeline step (in `zap-scan-stage.yml`):**

```yaml
- task: Docker@2
  inputs:
    command: run
    arguments: >
      -v $(System.DefaultWorkingDirectory)/infra/zap:/zap/wrk
      owasp/zap2docker-stable
      zap-baseline.py
        -t https://$(STAGING_FQDN)
        -x zap-report.xml
        -r zap-report.html
        -c /zap/wrk/zap-context.xml
        --hook=/zap/wrk/rules.tsv
        -I  # do not fail on warn
        # -z "-config api.disablekey=true" if needed
```

Parse `zap-report.xml` with a subsequent script step: if any `<alert>` has `<riskcode>3` (High) or `<riskcode>4` (Critical) → `exit 1`. Publish both HTML and XML as pipeline artifacts (`$(Build.ArtifactStagingDirectory)/zap/`).

### 6. `/api/health` endpoint

**File:** `app/api/health/route.ts`

Returns `200 { status: "ok", version: process.env.BUILD_VERSION }` with no authentication required and no DB query (intentional — the probe must not fail due to a DB connectivity blip; a separate `/api/health/db` endpoint can check DB connectivity but is not used as the liveness/readiness probe to avoid cascading restarts on transient DB latency).

`BUILD_VERSION` is injected at image build time as a Docker build arg (`ARG BUILD_VERSION`) and baked in as an env var (`ENV BUILD_VERSION=$BUILD_VERSION`). The pipeline passes `--build-arg BUILD_VERSION=$(Build.BuildId)-$(Build.SourceVersion:0:7)`.

### 7. Environment templates

**Files in `infra/env/`:**

`.env.example`:

```
# Database
DATABASE_URL=                    # PostgreSQL connection string — sourced from Key Vault in Azure
# Auth
BETTER_AUTH_SECRET=              # Random 32+ byte secret — sourced from Key Vault in Azure
BETTER_AUTH_URL=                 # e.g. https://app.yourdomain.com
# Entra SSO (optional — local-only mode if absent)
ENTRA_TENANT_ID=                 # Azure AD tenant GUID
ENTRA_CLIENT_ID=                 # App registration client ID
ENTRA_CLIENT_SECRET=             # Client secret — sourced from Key Vault in Azure
# Build
BUILD_VERSION=local
# App
NEXT_PUBLIC_APP_ENV=development
```

`.env.dev.template`, `.env.staging.template`, `.env.prod.template` — same keys, with non-secret values filled in (tenant ID, client ID, app env, URLs). Secret keys have the value `<from-keyvault>` as a placeholder; the pipeline replaces them with Key Vault reference URIs before passing to `az containerapp update`.

### 8. `.gitignore` additions

Ensure these patterns are present:

```
.env
.env.local
.env.*.local
.env.dev
.env.staging
.env.prod
```

---

## Dependencies

No new npm packages are required for the deployment and security gate infrastructure itself. All tooling is pipeline/Azure-native.

Pipeline and infra tooling (not npm):

- `owasp/zap2docker-stable` — Docker image, pulled at scan time by the pipeline.
- `azure/bicep` — Bicep CLI, available in Azure DevOps hosted agents.
- `azure/cli` — Azure CLI, available in Azure DevOps hosted agents.
- `drizzle-kit` — already in devDependencies from prior units; invoked in the migration job.

If CodeQL is not already wired from um1, the Azure DevOps CodeQL extension must be installed on the organization (free for public or licensed for private repos).

---

## Verification Checklist

### Dockerfile & image

- [ ] `docker build` succeeds from a clean checkout with no `.env` file present.
- [ ] `docker history <image>` shows no secret, connection string, or `.env` file in any layer.
- [ ] Container starts as non-root user (`docker run --user` shows UID 1000 / `nextjs`).
- [ ] `GET /api/health` returns `200` within the container without any DB connection.
- [ ] Image tag contains both the build ID and git SHA.

### Pipeline gates

- [ ] Introducing a known ESLint error fails the build stage.
- [ ] Introducing a failing Jest test fails the test+scan stage and blocks containerize.
- [ ] Introducing a CodeQL-detectable vulnerability (e.g., a SQL injection) fails the test+scan stage.
- [ ] A migration that exits non-zero (e.g., deliberate syntax error) fails the migrate stage; the app revision in dev still serves the old image.
- [ ] A smoke-test failure (`/api/health` returning 500) leaves old revision at 100% traffic; new revision is never promoted.
- [ ] Staging → prod promotion requires a manual approval click in Azure DevOps Environments.

### Blue-green & rollback

- [ ] After a successful deploy, `az containerapp revision list` shows the new revision active and the previous revision still present.
- [ ] Running `az containerapp ingress traffic set` shifting back to the previous revision completes in < 30 s and the app responds correctly on the old revision.
- [ ] Min 2 replicas confirmed in Container Apps scaling settings for the prod environment.

### Key Vault & Managed Identity

- [ ] The app Managed Identity has only the `Key Vault Secrets User` role on the vault (no write/delete).
- [ ] `DATABASE_URL` is not present as a plaintext environment variable in Container Apps revision definition — it appears as a Key Vault secret reference URI.
- [ ] Removing the Managed Identity role assignment causes the app to fail to start (secret fetch denied) — confirms the vault path is actually used.
- [ ] Rotating the `pg-connection-string-app` Key Vault secret and forcing a revision restart picks up the new value without a code change.

### Least-privilege DB role

- [ ] Connecting as `app_runtime` and running `DELETE FROM core."AUDIT_LOG" WHERE 1=0` returns `ERROR: permission denied`.
- [ ] Connecting as `app_runtime` and running `UPDATE core."AUDIT_LOG" SET event_type='x' WHERE 1=0` returns `ERROR: permission denied`.
- [ ] Connecting as `app_runtime` and running `CREATE TABLE core.forbidden ()` returns `ERROR: permission denied`.
- [ ] Connecting as `app_runtime`, all normal app operations (user list, session lookup, role assignment, audit INSERT) succeed.
- [ ] Connecting as `app_migrate`, all migrations in `db/migrations/` apply successfully.
- [ ] Connecting as `app_migrate`, `DELETE FROM core."AUDIT_LOG"` returns `ERROR: permission denied` (same constraint applies to the migration role).

### OWASP ZAP DAST

- [ ] ZAP scan stage runs against the dev/staging revision after every deploy to that environment.
- [ ] Introducing a deliberate reflected XSS in a response body causes ZAP to find a High finding and fail the stage.
- [ ] The ZAP HTML and XML reports are published as pipeline artifacts and accessible in the Azure DevOps run summary.
- [ ] Any suppressed findings in `rules.tsv` have a documented justification; the file is reviewed in PR.
- [ ] ZAP can authenticate to the app using the test user credentials defined in the context file and scans at least the `/administration/users` and `/administration/roles` pages.

### Secrets & env templates

- [ ] `git log --all --full-history -- '**/.env'` returns no results (no `.env` file was ever committed).
- [ ] `git grep -r 'DATABASE_URL=postgres'` returns no results in any committed file.
- [ ] `.env.example` contains every env var the app reads, with placeholder values and comments.
- [ ] A fresh developer checkout can run the app locally using only `.env.example` as a reference (after filling in real values in their own `.env`).

### End-to-end deploy

- [ ] Starting from a clean branch, a PR merge to `main` triggers the full five-stage pipeline and deploys to dev without manual steps (beyond any configured approval gates).
- [ ] Migrations run as a pre-traffic step; the app is never on the new image while migrations are pending.
- [ ] Post-deploy, the app signs in an SSO user and writes an `SSO_LOGIN` audit entry — confirming Key Vault secrets, DB connectivity, and app_runtime permissions are all correct end-to-end.
