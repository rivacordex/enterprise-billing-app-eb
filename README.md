# Enterprise Billing App

Next.js + Drizzle + PostgreSQL billing platform, with a **Kestra** workflow
engine (the shared `workflow-engine`) for the rating and bill-run pipelines.

This README is the **complete installation and operations guide for the local
development environment** — how to set up the database, the app, and the
workflow-management (Kestra) layer from nothing, and how to run them day to day.
The sequence in Parts 1–2 is the one that was last executed end-to-end, so
following it top-to-bottom on a clean machine produces a working stack.

The topology it produces:

| Component | Where | Port | Role it runs as |
| --- | --- | --- | --- |
| PostgreSQL 17 (pg_partman/pg_cron) | Docker (`enterprise-billing-app-db-1`) | 5432 | app connects as least-privilege `app_runtime` |
| Next.js app | host (`npm run dev`) | 3000 | — |
| Kestra OSS 1.3.35 (`workflow-engine`) | Docker (`enterprise-billing-app-workflow-engine-1`) | 8085 | `kestra_engine` |
| Azurite (Kestra blob storage) | Docker (`enterprise-billing-app-azurite-1`) | 10000 | — |

The app talks to Kestra **directly over HTTP** on `:8085`;
`BILLRUN_ENGINE_LOOPBACK=true` tells `lib/config.ts` to waive the HTTPS-only
engine-URL rule for the loopback host (no TLS proxy needed locally). In Azure,
Container Apps ingress provides HTTPS and the flag is left unset — see
`context/architecture.md` §1 "Local development equivalents".

> ### ⚠️ All credentials in this repo are throwaway LOCAL-DEV DUMMIES
>
> Every password, secret, token, and account below (and in `.env.example`,
> `workflow-management/dev/.env.example`, and the local `.env` this guide
> creates) is a **clearly-labelled local-development value that is NEVER used
> in any real environment**. Production sources all of them from **Azure Key
> Vault via Managed Identity** (`um30`). Do not paste a real credential into
> any file in this repository — the committed `*.env.example` files must stay
> publish-safe.

> **Design note — host-based, least-privilege.** The DB runs in Docker but the
> app runs on the host and connects as the least-privilege `app_runtime` role
> (not the `postgres` superuser). The superuser is used only for provisioning:
> `db:bootstrap-roles` and partman setup read `BOOTSTRAP_DATABASE_URL` directly,
> while migrations run as the superuser via a one-off `DATABASE_URL` override
> (Part 1 step 4 / "After pulling new commits") — `db:migrate` itself always
> reads `DATABASE_URL`. This mirrors production, where the app never has DDL
> rights.
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
  `/etc/caddy/Caddyfile` into `E:/Program Files/Git/etc/...` and flags like
  `taskkill /PID` into a path.

---

## Part 1 — Database + app

### 1. Install dependencies

```powershell
npm install
```

### 2. Create your `.env`

`.env` is git-ignored. Start from the template and set local values:

```powershell
Copy-Item .env.example .env
```

Then set the local-dev values in `.env`. The full working set is below —
**every value here is a dummy local-dev credential** (see the banner at the
top). Entra SSO is optional and left blank (local email/password sign-in is
unaffected); the bill-run engine block is wired in Part 2.

```dotenv
NODE_ENV=development
APP_TIMEZONE=Asia/Kuala_Lumpur

# App connects as the least-privilege role; BOOTSTRAP is the superuser used
# only for provisioning.
DATABASE_URL=postgresql://app_runtime:apprun_local_dev_pw@localhost:5432/enterprise_billing
BOOTSTRAP_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/enterprise_billing

# Local-only dummy secret — regenerate with: openssl rand -base64 32
BETTER_AUTH_SECRET=<generate a random 32+ char value>
BETTER_AUTH_URL=http://localhost:3000
NEXT_PUBLIC_APP_URL=http://localhost:3000

# Seeded break-glass LOCAL admin (dummy password).
BOOTSTRAP_ADMIN_EMAIL=admin@billing.com
BOOTSTRAP_ADMIN_PASSWORD=16Chars-Password

# Entra SSO — optional, disabled locally (leave blank to hide the SSO button).
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
ENTRA_TENANT_ID=
```

> Never commit a real Entra `MICROSOFT_CLIENT_SECRET`, tenant/client ID, or a
> real Postgres DSN into `.env` — even though `.env` is git-ignored, keeping it
> dummies-only keeps the repo publish-safe.

### 3. Start PostgreSQL

Builds the custom PG17 image (pg_partman + pg_cron) and starts the `db` service:

```powershell
docker compose up -d --build db
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
>
> PowerShell note: `$env:DATABASE_URL` stays set for the rest of the shell
> session. Open a new terminal (or `Remove-Item Env:DATABASE_URL`) before
> running the app so it connects as `app_runtime` again.

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

> ⓘ These roles and passwords live in the Postgres **data volume**, not in a
> migration — they are created once here and persist for the life of the volume.
> If the volume is ever removed, re-run this step.

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

Quick sanity check (should print a row count, not a permission error):

```powershell
docker exec -e PGPASSWORD=apprun_local_dev_pw enterprise-billing-app-db-1 `
  psql -U app_runtime -d enterprise_billing -tAc "SELECT count(*) FROM billing.bill_run;"
```

> ⓘ These grants live in the Postgres **data volume**, not in a migration — they
> are applied once here and persist for the life of the volume. If the volume is
> ever removed, re-run this step.

### 7. Run the app

```powershell
npm run dev
```

Open http://localhost:3000 and log in with `BOOTSTRAP_ADMIN_EMAIL` /
`BOOTSTRAP_ADMIN_PASSWORD` (default `admin@billing.com` / `16Chars-Password`).

At this point the app runs against the stub bill-run engine — Part 2 below wires
it to a real Kestra.

---

## Part 2 — Workflow management (Kestra) + rating/bill-run flows

> **Local topology.** The base deployment runs all functions on **one** shared
> Kestra instance (`workflow-engine`), hosting both the `rating` and `billrun`
> namespaces (`context/workflow-management/wfm-architecture.md` §5, "collapsed"
> topology). Rating's four flows are the real definitions; the bill-run flows
> deployed here are **no-op placeholders**
> (`workflow-management/flows/bill-run-*/local-dev/`) until billing phase 2.

### 8. Provision the `rating_runtime`, `billrun_runtime`, and Kestra DB roles

Order matters (`rating` roles' `REVOKE CONNECT … FROM PUBLIC` must run before
`billrun_runtime` is created — the `rm03a` ordering hazard):

```powershell
npm run db:bootstrap-rating-roles
npm run db:bootstrap-billrun-roles
npm run db:bootstrap-kestra-roles

docker exec -e PGPASSWORD=postgres enterprise-billing-app-db-1 `
  psql -U postgres -d enterprise_billing -v ON_ERROR_STOP=1 `
  -c "ALTER ROLE billrun_runtime WITH PASSWORD 'billrun_local_dev_pw';" `
  -c "ALTER ROLE kestra_engine WITH PASSWORD 'kestra_dev_password';"
```

> `kestra_dev_password` must match `workflow-management/dev/.env.example` — that
> committed file is the single source the Kestra container reads its datasource
> password from (all dummy dev values).

### 9. Build the worker image and start Kestra + Azurite

`--no-deps` keeps the running DB untouched (it won't recreate the `db` service
or run the containerized app; the DB roles were already provisioned in step 8):

```powershell
docker compose -f docker-compose.dev.yml -f workflow-management/dev/docker-compose.dev.yml build workflow-engine
docker compose -f docker-compose.dev.yml -f workflow-management/dev/docker-compose.dev.yml up -d --no-deps azurite workflow-engine
```

Kestra takes ~30–60s to run its own schema migrations on first boot. Wait for
healthy:

```powershell
docker inspect -f '{{.State.Health.Status}}' enterprise-billing-app-workflow-engine-1
```

UI: **http://localhost:8085/ui/** — user `workflow-ops@billing.ops`, password
`kestra_dev_dummy_Password1`.

### 10. Deploy the flows

**Recommended — the one-shot deployer** (mirrors the CI deploy stage; deploys
rating flows to `rating` and both bill-run placeholder flows to `billrun`,
idempotently):

```powershell
docker compose -f docker-compose.dev.yml -f workflow-management/dev/docker-compose.dev.yml run --rm --no-deps flow-deploy
```

You should see `4 flow(s) … 'rating'`, then `1 flow(s) … 'billrun'` twice. (A
`PrometheusMeterRegistry` WARN and a "command is deprecated" notice are benign.)

<details>
<summary>Alternative — deploy only the two bill-run flows by hand (curl)</summary>

```powershell
$U = "workflow-ops@billing.ops"; $P = "kestra_dev_dummy_Password1"
curl.exe -u "${U}:${P}" -H "Content-Type: application/x-yaml" --data-binary "@workflow-management/flows/bill-run-processor/local-dev/bill_run_processing.yml"  http://localhost:8085/api/v1/main/flows
curl.exe -u "${U}:${P}" -H "Content-Type: application/x-yaml" --data-binary "@workflow-management/flows/bill-run-distributor/local-dev/bill_run_distribution.yml" http://localhost:8085/api/v1/main/flows
```

</details>

### 11. Wire the app to Kestra

Add to `.env` (comment `URL`+`AUTH` out to fall back to the stub engine). The app
reaches Kestra directly over HTTP; `BILLRUN_ENGINE_LOOPBACK=true` waives the
HTTPS-only engine-URL rule for the loopback host — no TLS proxy, no CA trust.
`BILLRUN_APP_TOKEN` is the inbound M2M bearer token (dummy local value, ≥32
chars):

```dotenv
BILLRUN_ENGINE_LOOPBACK=true
BILLRUN_ENGINE_URL=http://localhost:8085/api/v1/main
BILLRUN_ENGINE_AUTH=workflow-ops@billing.ops:kestra_dev_dummy_Password1
BILLRUN_ENGINE_NAMESPACE=billrun
BILLRUN_APP_TOKEN=<generate: node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))">
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

## Part 3 — Optional: the `_SAMPLE_` bill-run demo scenario

Seeds an unmistakably-fake `_SAMPLE_` customer + charges so you can click a bill
run through the UI end-to-end (real Kestra `executionId`).

### 12. Point at the local blob store

Add to `.env` and restart `npm run dev`:

```dotenv
# Invoice-PDF store — the running Azurite container (Microsoft's published
# well-known dev account/key; host app reaches it at 127.0.0.1:10000). REQUIRED
# for posting to render+store invoice PDFs — without it the INV document still
# posts but the artifact is "render-pending" ("No blob store configured").
BILLRUN_BLOB_CONNECTION_STRING=DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;
```

Invoice-PDF rendering also needs Chromium on the host once:
`npx playwright install chromium`.

### 13. Seed the sample scenario — **as the superuser** ⚠️

`db:seed-sample` writes `_SAMPLE_` rows into `rating.udr_rated`, and the
least-privilege `app_runtime` role deliberately has **no INSERT on rating
tables** (only `rating_runtime` writes rated usage — architecture role
boundary). So run it with the superuser `DATABASE_URL`, exactly like the Part 1
baseline seeds:

```powershell
$env:DATABASE_URL='postgresql://postgres:postgres@localhost:5432/enterprise_billing'; npm run db:seed-sample
```

> Bash: `DATABASE_URL='postgresql://postgres:postgres@localhost:5432/enterprise_billing' npm run db:seed-sample`

It seeds one `_SAMPLE_ Nusantara Demo` customer, 3 billing accounts (2 full-
period + 1 partial), and 4 `udr_rated` charges for the demo period (previous
month). The seed is idempotent — it purges any prior `_SAMPLE_` graph first, so
it is safe to re-run.

### 14. Trigger it in the UI

Open the **Bill Runs** page (loading it lazily materializes the due
`SCHEDULED` run). Trigger the run on the **"Monthly – Day 1"** cycle — that is
the cycle the `_SAMPLE_` accounts are on. It hits real Kestra and returns a real
execution id. As noted above, the local placeholder flow won't advance the run
to `PROCESSED`.

---

## Running the stack day to day

After Part 1 (and Part 2, if you need the workflow engine), this is all you need.

### Start

```powershell
# 1. Database — always needed
docker compose start db

# 2. Workflow engine + blob store — only for rating / bill-run work
docker compose -f docker-compose.dev.yml -f workflow-management/dev/docker-compose.dev.yml start workflow-engine azurite

# 3. App (host)
npm run dev
```

First run of the day, or after a Docker Desktop restart, `start` may report the
containers don't exist — use `up -d` instead of `start` for the same services;
it reuses the existing volumes and data.

### Stop

```powershell
# App: Ctrl-C in the dev-server terminal
docker compose -f docker-compose.dev.yml -f workflow-management/dev/docker-compose.dev.yml stop azurite workflow-engine
docker compose stop db
```

`stop` halts the containers and **keeps all data**. Restart with the Start
block above; nothing needs re-seeding, re-granting, or re-migrating.

### Check what's running

```powershell
docker compose ps
curl.exe http://localhost:3000/api/health
```

`/api/health` returning OK means the app process is up and serving. It is a
pure liveness probe and deliberately does **no** DB query (so a transient DB
blip can't trip it into a restart loop) — a dedicated DB-connectivity check
(`/api/health/db`) is reserved but not yet implemented. For a deeper check that
the workflow engine is genuinely reachable and executing, trigger a real
execution:

```powershell
$U = "workflow-ops@billing.ops"; $P = "kestra_dev_dummy_Password1"
curl.exe -u "${U}:${P}" -X POST -F 'ban_ids=["BAN0001","BAN0002"]' `
  http://localhost:8085/api/v1/main/executions/billrun/bill_run_processing
```

### After pulling new commits

```powershell
npm install          # if package.json changed

# New migrations are DDL — they must run as the superuser/owner, because the
# app_runtime DATABASE_URL in your .env has no DDL rights. Override it for this
# one command (same idiom as Part 1 step 4), then clear the override so the app
# reconnects as app_runtime:
$env:DATABASE_URL='postgresql://postgres:postgres@localhost:5432/enterprise_billing'
npm run db:migrate   # if db/migrations/ gained a file
Remove-Item Env:DATABASE_URL

npm run dev
```

Migrations are forward-only and idempotent — running `db:migrate` when there is
nothing new applies nothing. If a pulled migration adds a **new schema**, also
re-run `npm run db:bootstrap-roles` (Part 1 step 5) so `app_runtime` picks up its
grants on the new objects.

> **Config-row descriptions and already-migrated databases.** Drizzle's migrator
> applies a migration only when its journal timestamp is newer than the last one
> applied; it does not re-check file hashes. So if a _previously applied_
> migration's SQL is edited, your existing database silently skips it — only a
> brand-new database picks the change up. When that happens for a `system_config`
> row (as it did for `app`/`app_name`'s description), bring an existing
> environment level with one statement:
>
> ```sql
> UPDATE core.system_config
>    SET description = 'Application display name — drives the top-bar wordmark, the sign-in page and browser tab titles. Maximum 40 characters; longer values are truncated with an ellipsis in the top bar.'
>  WHERE config_group = 'app' AND config_key = 'app_name';
> ```

### Troubleshooting

**Port 3000 is already in use.** A stray `next dev` is still running. On Windows:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'next dev' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Bash: `pkill -f "next dev"`.

**The app starts but every page 500s.** The database container is stopped, or
the app is connecting as a role whose password was never set — re-run Part 1
step 5.

**Kestra is up but executions never start.** Check the app is pointed at it
(Part 2 step 11) and that `BILLRUN_ENGINE_LOOPBACK=true` is set in `.env`;
without it `lib/config.ts` rejects the plain-HTTP loopback engine URL.

---

## Credentials & endpoints (local dev)

All values below are **local-only dummies** — never used in any real
environment (production sources them from Key Vault via Managed Identity).

| Item | Value |
| --- | --- |
| App | http://localhost:3000 · `admin@billing.com` / `16Chars-Password` |
| Kestra UI | http://localhost:8085/ui/ · `workflow-ops@billing.ops` / `kestra_dev_dummy_Password1` |
| Postgres superuser | `postgres` / `postgres` @ `localhost:5432/enterprise_billing` |
| `app_runtime` / `app_migrate` | `apprun_local_dev_pw` |
| `billrun_runtime` | `billrun_local_dev_pw` |
| `kestra_engine` | `kestra_dev_password` |
| Azurite blob | Microsoft's published well-known dev account/key (`devstoreaccount1`) |

---

## Useful scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Next.js dev server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | unit + integration suites |
| `npm run db:setup` | migrate + partman + full baseline seed |
| `npm run db:migrate` | apply any new forward migrations (idempotent) |
| `npm run db:seed-sample` | `_SAMPLE_*` bill-run demo scenario — run as **superuser**, see Part 3 |
| `npm run db:bootstrap-roles` | create `app_runtime`/`app_migrate` + grants |
| `docker compose ps` | what's running, and on which ports |
| `curl http://localhost:3000/api/health` | app liveness (no DB query) |

## Learn more

- Next.js docs: https://nextjs.org/docs
- Workflow-management architecture: `context/workflow-management/wfm-architecture.md`
- Module context: `context/billing-management/` and `context/rating-management/`
- DB role details: `infra/docs/db-role-verification.md`
- Bill-run flow placeholders: `workflow-management/flows/bill-run-processor/README.md`
