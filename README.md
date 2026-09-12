# Enterprise Billing App

Next.js + Drizzle + PostgreSQL billing platform, with an external **Kestra**
workflow engine for the bill-run pipeline.

This README documents the **local development environment** exactly as it is set
up today. The topology it produces:

| Component | Where | Port | Role it runs as |
| --- | --- | --- | --- |
| PostgreSQL 17 (pg_partman/pg_cron) | Docker (`enterprise-billing-app-db-1`) | 5432 | app connects as least-privilege `app_runtime` |
| Next.js app | host (`npm run dev`) | 3000 | — |
| Kestra OSS 1.3.35 (workflow engine) | Docker (`enterprise-billing-app-workflow-engine-1`) | 8085 | `kestra_engine` |
| Azurite (Kestra blob storage) | Docker (`enterprise-billing-app-azurite-1`) | 10000 | — |

The app talks to Kestra **directly over HTTP** on `:8085`; `BILLRUN_ENGINE_LOOPBACK=true`
tells `lib/config.ts` to waive the HTTPS-only engine-URL rule for the loopback host
(no TLS proxy needed locally). In Azure, Container Apps ingress provides HTTPS and the
flag is left unset — see `context/architecture.md` §1 "Local development equivalents".

> **Design note — host-based, least-privilege.** The DB runs in Docker but the
> app runs on the host and connects as the least-privilege `app_runtime` role
> (not the `postgres` superuser). The superuser connection
> (`BOOTSTRAP_DATABASE_URL`) is used only for provisioning (migrations, roles,
> partman). This mirrors production, where the app never has DDL rights.
>
> A fully-containerized alternative exists (`docker compose -f
> docker-compose.dev.yml up`) that runs everything in Docker as `postgres` — but
> it bypasses the role boundary and can't do the Playwright/PRO-FORMA preview.
> The instructions below are the host-based path.

---

## Prerequisites

- **Docker Desktop** (Compose v2)
- **Node.js ≥ 22** (`node -v`)
- **Windows/PowerShell** is assumed below (this repo is developed on Windows).
  Bash equivalents are noted where the syntax differs. On Windows, prefer the
  **PowerShell** shell for `docker run -v` / `docker exec` / `docker cp` with
  container-absolute paths — Git-Bash (MSYS) silently mangles paths like
  `/etc/caddy/Caddyfile` into `E:/Program Files/Git/etc/...`.

---

## Part A — Database + app

### 1. Install dependencies

```powershell
npm install
```

### 2. Create your `.env`

`.env` is git-ignored. Start from the template and set local values:

```powershell
Copy-Item .env.example .env
```

Then edit `.env`:

```dotenv
NODE_ENV=development
APP_TIMEZONE=Asia/Kuala_Lumpur

# App connects as the least-privilege role; BOOTSTRAP is the superuser used
# only for provisioning.
DATABASE_URL=postgresql://app_runtime:apprun_local_dev_pw@localhost:5432/enterprise_billing
BOOTSTRAP_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/enterprise_billing

BETTER_AUTH_SECRET=<generate: openssl rand -base64 32>
BETTER_AUTH_URL=http://localhost:3000
NEXT_PUBLIC_APP_URL=http://localhost:3000

BOOTSTRAP_ADMIN_EMAIL=admin@billing.com
BOOTSTRAP_ADMIN_PASSWORD=16Chars-Password
```

### 3. Start PostgreSQL

Builds the custom PG17 image (pg_partman + pg_cron) and starts the `db` service:

```powershell
docker compose up -d db
```

Wait until it reports healthy:

```powershell
docker inspect -f '{{.State.Health.Status}}' enterprise-billing-app-db-1
```

### 4. Migrate + set up partitioning + seed (as the superuser)

The initial migrate must run as the **superuser/owner** (the `app_runtime` role
doesn't exist yet, and tables must be owner-owned for the audit-log REVOKEs to
bite). Override `DATABASE_URL` for this one command:

```powershell
$env:DATABASE_URL='postgresql://postgres:postgres@localhost:5432/enterprise_billing'; npm run db:setup
```

`db:setup` runs: migrations → pg_partman setup (audit/billing/rating) → the full
baseline seeds (admin, RBAC, product, customer, accounts, ordering, billing,
rating catalog).

> Bash: `DATABASE_URL='postgresql://postgres:postgres@localhost:5432/enterprise_billing' npm run db:setup`

### 5. Create the least-privilege roles + passwords

```powershell
npm run db:bootstrap-roles
```

Set local passwords for the roles the app/migrate use (the bootstrap SQL
deliberately contains no password):

```powershell
docker exec -e PGPASSWORD=postgres enterprise-billing-app-db-1 `
  psql -U postgres -d enterprise_billing -v ON_ERROR_STOP=1 `
  -c "ALTER ROLE app_runtime WITH PASSWORD 'apprun_local_dev_pw';" `
  -c "ALTER ROLE app_migrate WITH PASSWORD 'apprun_local_dev_pw';"
```

### 6. Grant `app_runtime` the bm-era billing tables ⚠️ required

Because the initial migrate ran as the superuser in one shot (not incrementally
as `app_migrate`), the `ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate` grants in
`bootstrap-db-roles.sql` never fired for the bill-run tables — so `app_runtime`
has **no** rights on `bill_run` / `customer_bill` / etc. and the Bill Run pages
would 403. Apply the intended grants (parents only; `pgledger_*` stays excluded;
`customer_bill_tax_item` is SELECT-only per the phase-2 two-writer boundary):

```powershell
docker exec -e PGPASSWORD=postgres enterprise-billing-app-db-1 `
  psql -U postgres -d enterprise_billing -v ON_ERROR_STOP=1 -c @"
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  billing.bill_run, billing.bill_run_account, billing.bill_run_account_stage,
  billing.bill_run_distribution, billing.bill_run_invoices, billing.customer_bill
TO app_runtime;
GRANT SELECT ON TABLE billing.customer_bill_tax_item TO app_runtime;
"@
```

### 7. Run the app

```powershell
npm run dev
```

Open http://localhost:3000 and log in with `BOOTSTRAP_ADMIN_EMAIL` /
`BOOTSTRAP_ADMIN_PASSWORD` (default `admin@billing.com` / `16Chars-Password`).

At this point the app runs against the stub bill-run engine — Part B below wires
it to a real Kestra.

---

## Part B — Workflow management (Kestra) + bill-run flows

> **Local-only deviation.** The architecture (rm04 §D1) mandates a *dedicated*
> bill-run Kestra engine. For local dev we run the bill-run flows in a `billrun`
> namespace on the **rating** engine (one shared instance). The real flows live
> in a separate workflow-management repo; the flows deployed here are
> **no-op placeholders** (`workflow-management/flows/bill-run-*/local-dev/`).

### 8. Provision the `billrun_runtime` and Kestra DB roles

Order matters (`rating` roles' `REVOKE CONNECT … FROM PUBLIC` must run first):

```powershell
npm run db:bootstrap-rating-roles
npm run db:bootstrap-billrun-roles
npm run db:bootstrap-kestra-roles

docker exec -e PGPASSWORD=postgres enterprise-billing-app-db-1 `
  psql -U postgres -d enterprise_billing -v ON_ERROR_STOP=1 `
  -c "ALTER ROLE billrun_runtime WITH PASSWORD 'billrun_local_dev_pw';" `
  -c "ALTER ROLE kestra_engine WITH PASSWORD 'kestra_dev_password';"
```

> `kestra_dev_password` must match `workflow-management/dev/.env.example` — that file is
> the single source the Kestra container reads its datasource password from.

### 9. Build the worker image and start Kestra + Azurite

`--no-deps` keeps the running DB/app untouched (it won't recreate the `db`
service or run the containerized app):

```powershell
docker compose -f docker-compose.dev.yml -f workflow-management/dev/docker-compose.dev.yml build workflow-engine
docker compose -f docker-compose.dev.yml -f workflow-management/dev/docker-compose.dev.yml up -d --no-deps azurite workflow-engine
```

Kestra takes ~30–60s to run its own schema migrations on first boot. UI:
**http://localhost:8085/ui/** — user `rating-ops@example.invalid`, password
`Kestra_Dev_Basic_Auth_Password1`.

### 10. Deploy the bill-run flows to the `billrun` namespace

```powershell
$U = "rating-ops@example.invalid"; $P = "Kestra_Dev_Basic_Auth_Password1"
curl.exe -u "${U}:${P}" -H "Content-Type: application/x-yaml" --data-binary "@workflow-management/flows/bill-run-processor/local-dev/bill_run_processing.yml"  http://localhost:8085/api/v1/main/flows
curl.exe -u "${U}:${P}" -H "Content-Type: application/x-yaml" --data-binary "@workflow-management/flows/bill-run-distributor/local-dev/bill_run_distribution.yml" http://localhost:8085/api/v1/main/flows
```

### 11. Wire the app to Kestra

Add to `.env` (comment `URL`+`AUTH` out to fall back to the stub engine). The app
reaches Kestra directly over HTTP; `BILLRUN_ENGINE_LOOPBACK=true` waives the
HTTPS-only engine-URL rule for the loopback host — no TLS proxy, no CA trust:

```dotenv
BILLRUN_ENGINE_LOOPBACK=true
BILLRUN_ENGINE_URL=http://localhost:8085/api/v1/main
BILLRUN_ENGINE_AUTH=rating-ops@example.invalid:Kestra_Dev_Basic_Auth_Password1
BILLRUN_ENGINE_NAMESPACE=billrun
```

Restart the dev server (plain — nothing extra needed):

```powershell
npm run dev
```

> The HTTPS-only rule still holds for any **non-loopback** host: a remote
> `http://` URL — or `BILLRUN_ENGINE_LOOPBACK=true` pointed at a non-loopback
> host — fails fast at boot, so the flag can never send Basic-Auth to a remote
> engine in the clear. In Azure the flag is left unset (Container Apps ingress
> provides HTTPS).

**Caveat:** the placeholder flows do no billing work and send no M2M callbacks,
so a UI-triggered run gets a real Kestra `executionId` (and "Check status" /
"Cancel" hit real Kestra) but won't advance through its stages.

---

## Credentials & endpoints (local dev)

| Item | Value |
| --- | --- |
| App | http://localhost:3000 · `admin@billing.com` / `16Chars-Password` |
| Kestra UI | http://localhost:8085/ui/ · `rating-ops@example.invalid` / `Kestra_Dev_Basic_Auth_Password1` |
| Postgres superuser | `postgres` / `postgres` @ `localhost:5432/enterprise_billing` |
| `app_runtime` / `app_migrate` | `apprun_local_dev_pw` |
| `billrun_runtime` | `billrun_local_dev_pw` |
| `kestra_engine` | `kestra_dev_password` |

All passwords above are **local-only dummies** — never used in any real
environment (production sources them from Key Vault).

## Verify a real execution

```powershell
$U = "rating-ops@example.invalid"; $P = "Kestra_Dev_Basic_Auth_Password1"
curl.exe -u "${U}:${P}" -X POST -F 'ban_ids=["BAN0001","BAN0002"]' `
  http://localhost:8085/api/v1/main/executions/billrun/bill_run_processing
```

## Teardown

```powershell
# stop app: Ctrl-C the dev server
docker compose -f docker-compose.dev.yml -f workflow-management/dev/docker-compose.dev.yml stop azurite workflow-engine
docker compose stop db          # keep data
docker compose down -v          # stop and WIPE the DB volume (re-run Part A after)
```

> A `docker compose down -v` wipes the DB — you must re-run all of Part A
> (incl. the step-6 grant patch) and step 8's role passwords afterward.

---

## Useful scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Next.js dev server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | unit + integration suites |
| `npm run db:setup` | migrate + partman + full baseline seed |
| `npm run db:seed-sample` | `_SAMPLE_*` bill-run demo scenario (placeholder mode) |
| `npm run db:bootstrap-roles` | create `app_runtime`/`app_migrate` + grants |

## Learn more

- Next.js docs: https://nextjs.org/docs
- Module context: `context/billing-management/` and `context/rating-management/`
- DB role details: `infra/docs/db-role-verification.md`
- Bill-run flow placeholders: `workflow-management/flows/bill-run-processor/README.md`
