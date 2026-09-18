# Enterprise Billing App

Next.js + Drizzle + PostgreSQL billing platform, with a **Kestra** workflow
engine (the shared `workflow-engine`) for the rating and bill-run pipelines.

This README is the **complete installation and operations guide for the local
development environment** — how to bring the database, the app, and the
workflow-management (Kestra) layer up from nothing, and run them day to day.
Following Parts 1–3 top-to-bottom on a clean machine produces a working stack.

> **Last verified end-to-end: 2026-09-18** on Windows 11 / Node 24.11.1 /
> Docker 28.5.2 / Compose v2.40.3 / Next.js 16.2.9, from an empty Docker state
> (no `enterprise-billing-app-*` containers or volumes). Every command below was
> run in order, and a `_SAMPLE_` bill run was driven through the full
> **`SCHEDULED → COMPLETED` lifecycle** — processed, approved, posted to the
> ledger, and distributed (4 invoice PDFs + the run report delivered to the
> `loopback` sink) — via the live-Kestra smoke journey
> (`npm run billrun:live-kestra-smoke`). Read **Tests, typecheck and lint**
> before `npm run test`: its second half wipes whatever database `DATABASE_URL`
> names, and takes the workflow engine with it.

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
> creates) is a **clearly-labelled local-development value that is NEVER used in
> any real environment**. Production sources all of them from **Azure Key Vault
> via Managed Identity** (`um30`). The committed `*.env.example` files must stay
> publish-safe — never paste a real credential into any file in this repository.

> **Design note — host-based, least-privilege.** The DB runs in Docker but the
> app runs on the host and connects as the least-privilege `app_runtime` role
> (not the `postgres` superuser). The superuser is used only for provisioning:
> `db:bootstrap-roles` and partman setup read `BOOTSTRAP_DATABASE_URL` directly,
> while the initial migrate runs as the superuser via a one-off `DATABASE_URL`
> override (Part 1 step 4 / "After pulling new commits") — `db:migrate` itself
> always reads `DATABASE_URL`. This mirrors production, where the app never has
> DDL rights.
>
> A fully-containerized alternative exists (`docker compose -f
> docker-compose.dev.yml up`) that runs everything in Docker as `postgres`, but
> it bypasses the role boundary. The instructions below are the host-based path.
>
> **Consequence worth knowing up front:** in this host-based path there is no
> `app` **container**, so anything inside the Docker network that addresses the
> app by its Compose service name (`http://app:3000`) — as the bill-run flows'
> M2M callbacks do — would not reach it. The local-dev compose closes that gap
> by mapping `app` to the Docker host gateway for the engine; see Part 2 step 11.

---

## Prerequisites

- **Docker Desktop** (Compose v2 or newer; verified on v2.40). Start it and wait
  for the engine before running any `docker` command — a stopped Docker Desktop
  fails with `failed to connect to the docker API at
  npipe:////./pipe/dockerDesktopLinuxEngine`.
- **Node.js ≥ 22** (`node -v`). `.nvmrc` pins 22; Node 24 also works.
- **Windows/PowerShell** is assumed below (this repo is developed on Windows).
  Bash equivalents are noted where the syntax differs. On Windows, prefer
  **PowerShell** for `docker run -v` / `docker exec` / `docker cp` with
  container-absolute paths — Git-Bash (MSYS) silently mangles paths like
  `/etc/caddy/Caddyfile` and flags like `taskkill /PID`.
- **Git line endings.** `.gitattributes` pins `*.sql` to LF, which keeps three
  byte-exact test files passing under Git for Windows' default
  `core.autocrlf=true`. A checkout predating that file needs re-normalizing —
  see **Troubleshooting → Older checkouts**.

---

## Part 1 — Database + app

### 1. Install dependencies

```powershell
npm install
```

`npm audit` reports pre-existing advisories in the transitive tree; they do not
affect local setup.

### 2. Create your `.env`

`.env` is git-ignored. Start from the template and set local values:

```powershell
Copy-Item .env.example .env
```

The full working set is below — **every value is a dummy local-dev credential**
(see the banner). Entra SSO is optional and left blank (local email/password
sign-in is unaffected); the bill-run engine block is wired in Part 2.

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

> **`BOOTSTRAP_DATABASE_URL` is not in `.env.example`** — copying the template
> does not give you that line, and the role/partman bootstrap scripts read it
> directly. Add it by hand, as shown. Everything else above *is* in the
> template; you are editing values, not adding keys.
> `BILLRUN_BLOB_CONNECTION_STRING` (Part 3) also ships uncommented, so it is
> already correct in your `.env` from this step.

### 3. Start PostgreSQL

Builds the custom PG17 image (pg_partman + pg_cron) and starts the `db` service:

```powershell
docker compose up -d --build db
```

Wait until it reports healthy (a few seconds after the build):

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
rating catalog). It ends with `Rating event catalog seeded successfully.`

> Bash: `DATABASE_URL='postgresql://postgres:postgres@localhost:5432/enterprise_billing' npm run db:setup`
>
> PowerShell note: `$env:DATABASE_URL` stays set for the rest of the shell
> session. Open a new terminal (or `Remove-Item Env:DATABASE_URL`) before running
> the app so it connects as `app_runtime` again. The override works even though
> every `db:*` script passes `--env-file=.env`: Node's `--env-file` does not
> overwrite variables already present in the process environment.

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
> migration. If the volume is ever removed, re-run this step.

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

Sanity check (should print a row count, not a permission error):

```powershell
docker exec -e PGPASSWORD=apprun_local_dev_pw enterprise-billing-app-db-1 `
  psql -U app_runtime -d enterprise_billing -tAc "SELECT count(*) FROM billing.bill_run;"
```

> ⓘ Like the passwords, these grants live in the data volume, not a migration.
> If the volume is ever removed, re-run this step.

### 7. Run the app

```powershell
npm run dev
```

Open http://localhost:3000 and log in with `BOOTSTRAP_ADMIN_EMAIL` /
`BOOTSTRAP_ADMIN_PASSWORD` (default `admin@billing.com` / `16Chars-Password`).
At this point the app runs against the stub bill-run engine — Part 2 wires it to
a real Kestra.

> The dev console logs CSP `style-src 'self'` violations for inline styles. They
> are dev-mode noise (Next injects inline styles the production CSP header also
> governs) and do not affect rendering.

---

## Part 2 — Workflow management (Kestra) + rating/bill-run flows

> **Local topology.** The base deployment runs all functions on **one** shared
> Kestra instance (`workflow-engine`), hosting both the `rating` and `billrun`
> namespaces (`context/workflow-management/wfm-architecture.md` §5, "collapsed").
> Rating's four flows are the real definitions; the bill-run flows deployed here
> are the **local-dev placeholders**
> (`workflow-management/flows/bill-run-*/local-dev/`), which carry real
> processing SQL and real callback tasks — see step 11 for what that gets you.

### 8. Provision the `rating_runtime`, `billrun_runtime`, and Kestra DB roles

Order matters (`rating` roles' `REVOKE CONNECT … FROM PUBLIC` must run before
`billrun_runtime` is created — the `rm03a` ordering hazard):

```powershell
npm run db:bootstrap-rating-roles
npm run db:bootstrap-billrun-roles
npm run db:bootstrap-kestra-roles
```

Each script prints a `DROP ... does not exist, skipping` notice on a fresh
database before its success line — that is expected, not an error.

Now set the role passwords. ⚠️ **These three values are not free choices** — each
must match the value the Kestra container reads from the committed
`workflow-management/dev/.env.example`, the single source the flows and the
engine datasource use:

```powershell
docker exec -e PGPASSWORD=postgres enterprise-billing-app-db-1 `
  psql -U postgres -d enterprise_billing -v ON_ERROR_STOP=1 `
  -c "ALTER ROLE billrun_runtime WITH PASSWORD 'billrun_runtime_dev_password';" `
  -c "ALTER ROLE rating_runtime  WITH PASSWORD 'rating_runtime_dev_password';" `
  -c "ALTER ROLE kestra_engine   WITH PASSWORD 'kestra_dev_password';"
```

| Role | Password | Read from `dev/.env.example` as | Used by |
| --- | --- | --- | --- |
| `kestra_engine` | `kestra_dev_password` | `KESTRA_DATASOURCES_POSTGRES_PASSWORD` | the engine's own datasource |
| `billrun_runtime` | `billrun_runtime_dev_password` | `SECRET_BILLRUN_RUNTIME_PASSWORD` | `bill_run_processing`'s psql tasks (the two-writer identity) |
| `rating_runtime` | `rating_runtime_dev_password` | `SECRET_RATING_RUNTIME_PASSWORD` | the rating worker's `db.py` |

### 9. Build the worker image and start Kestra + Azurite

`--no-deps` keeps the running DB untouched (the roles were provisioned in step 8):

```powershell
docker compose -f docker-compose.dev.yml -f workflow-management/dev/docker-compose.dev.yml build workflow-engine
docker compose -f docker-compose.dev.yml -f workflow-management/dev/docker-compose.dev.yml up -d --no-deps azurite workflow-engine
```

Kestra takes ~30–60s to run its own schema migrations on first boot. Wait for
healthy:

```powershell
docker inspect -f '{{.State.Health.Status}}' enterprise-billing-app-workflow-engine-1
```

Then create the blob containers — **required, once per Azurite volume**:

```powershell
npm run dev:azurite-init
```

> ⚠️ **Don't skip this.** Azurite does not auto-create containers and neither
> does Kestra — it PUTs into `kestra-internal` and takes the 404. Kestra's
> **internal storage** is where every file-producing task parks output for the
> next task (`kestra:///…` URIs), so without that container the **distribution**
> flow downloads each invoice PDF (Azurite logs a `206`) and then dies writing
> the result into its own storage — surfacing as a bare `BlobStorageException:
> Status code 404`. The two containers are distinct: `invoices` is the **app's**
> durable artifact store (PDFs + run report, registered in `bill_run_invoices`);
> `kestra-internal` is the **engine's** transient task-to-task scratch, named by
> `KESTRA_STORAGE_AZURE_CONTAINER` in the shared `kestra.yml`.

UI: **http://localhost:8085/ui/** — user `workflow-ops@billing.ops`, password
`kestra_dev_dummy_Password1`.

### 10. Deploy the flows

**Recommended — the one-shot deployer** (mirrors the CI deploy stage; deploys
rating flows to `rating` and both bill-run placeholders to `billrun`,
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
HTTPS-only engine-URL rule for the loopback host — no TLS proxy, no CA trust:

```dotenv
BILLRUN_ENGINE_LOOPBACK=true
BILLRUN_ENGINE_URL=http://localhost:8085/api/v1/main
BILLRUN_ENGINE_AUTH=workflow-ops@billing.ops:kestra_dev_dummy_Password1
BILLRUN_ENGINE_NAMESPACE=billrun
BILLRUN_APP_TOKEN=billrun_dev_app_token_change_me_0123456789
```

(`BILLRUN_ENGINE_NAMESPACE=billrun` already ships in `.env.example`; the other
four are new lines.)

> ⚠️ **`BILLRUN_APP_TOKEN` is NOT a free choice — do not generate a random one.**
> It is the *inbound* M2M bearer the engine presents on every callback, so it
> must equal the base64-**decoded** `SECRET_BILLRUN_APP_TOKEN` from the committed
> `workflow-management/dev/.env.example` (Kestra OSS's env secret backend
> base64-decodes every `SECRET_<NAME>`). That decodes to exactly the value above
> — verify with:
>
> ```bash
> node -e "console.log(Buffer.from('YmlsbHJ1bl9kZXZfYXBwX3Rva2VuX2NoYW5nZV9tZV8wMTIzNDU2Nzg5','base64').toString())"
> ```
>
> A mismatched token makes the app reject **every** stage callback with 401 (it
> is fail-closed) and the run never leaves `PROCESSING`.

Restart the dev server:

```powershell
npm run dev
```

> The HTTPS-only rule still holds for any **non-loopback** host: a remote
> `http://` URL — or `BILLRUN_ENGINE_LOOPBACK=true` pointed at a non-loopback
> host — fails fast at boot, so the flag can never send Basic-Auth to a remote
> engine in the clear. In Azure the flag is left unset.

**What you get locally.** The full processing leg works: triggering a run reaches
real Kestra, every account runs all five stages (validation → collection →
aggregation → taxation → verification) as `billrun_runtime` against the real
database, each stage POSTs its `DONE` callback back to the app, and the run
settles to **`PROCESSED`** with real `customer_bill` rows.

**Distribution works too, to the `loopback` target.** Approve → post → distribute
completes the full `SCHEDULED → COMPLETED` lifecycle locally: the flow downloads
each stored artifact from Azurite and writes it to the engine's own mounted sink,
inspectable on the host under `workflow-management/dev/distribution/`.

The **`sftp`** target is the part this guide does not cover — it needs the SFTP
endpoint and key material set up (`workflow-management/dev/sftp/README.md`).
`loopback` is the default and needs none of that.

> Two repo-level fixes were required to make the host-based callback + loop paths
> work end-to-end; both are already in the repo, so a fresh clone gets the
> working behaviour. (1) `bill_run_processing` reads its ForEach loop value as
> `{{ parents[0].taskrun.value }}` — a nested ForEach value is not inherited by
> descendants. (2) `workflow-management/dev/docker-compose.dev.yml` maps
> `app → host-gateway` (`extra_hosts`) for the engine, so callbacks to
> `http://app:3000` reach the host-run app without touching any flow URI.

---

## Part 3 — Optional: the `_SAMPLE_` bill-run demo scenario

Seeds an unmistakably-fake `_SAMPLE_` customer + charges so you can click a bill
run through the UI end-to-end (real Kestra `executionId`).

### 12. Point at the local blob store

`.env.example` already ships this line uncommented, so after Part 1 step 2 your
`.env` has it. Confirm it points at `127.0.0.1:10000`, and restart `npm run dev`
if you change it:

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
tables** (only `rating_runtime` writes rated usage). So run it with the superuser
`DATABASE_URL`, exactly like the Part 1 baseline seeds:

```powershell
$env:DATABASE_URL='postgresql://postgres:postgres@localhost:5432/enterprise_billing'; npm run db:seed-sample
```

> Bash: `DATABASE_URL='postgresql://postgres:postgres@localhost:5432/enterprise_billing' npm run db:seed-sample`

It seeds the `ci` profile: one `_SAMPLE_` customer party role, **6 billing
accounts** covering distinct scenarios, and **6 `udr_rated` charges** for the
demo period (the previous calendar month):

| BAN | Scenario |
| --- | --- |
| `BAN00000001` | recurring-and-usage |
| `BAN00000002` | multiple-subscriptions |
| `BAN00000003` | recurring-only |
| `BAN00000004` | no-charges |
| `BAN00000005` | partial-period |
| `BAN00000006` | bill-notused |

The seed logs the exact demo period it chose and the cycle to trigger. It is
idempotent — it purges any prior `_SAMPLE_` graph first, so it is safe to re-run.

### 14. Trigger it in the UI

Open the **Bill Runs** page (loading it lazily materializes the due `SCHEDULED`
runs — you should see `BRN00000001` on "Monthly – Day 1" and `BRN00000002` on
"Monthly – Day 15"). Press **Run** on the **"Monthly – Day 1"** cycle — that is
the cycle the `_SAMPLE_` accounts are on — then **Confirm Run**.

What you should observe:

```powershell
docker exec -e PGPASSWORD=postgres enterprise-billing-app-db-1 `
  psql -U postgres -d enterprise_billing `
  -c "SELECT bill_run_id, status, processing_execution_id FROM billing.bill_run ORDER BY 1;"
```

```
 bill_run_id |   status   | processing_execution_id
-------------+------------+-------------------------
 BRN00000001 | PROCESSING | 3WXHpVPCitfNKjTvyKxUUj
 BRN00000002 | SCHEDULED  |
```

A real execution id means the app→Kestra leg is wired. Give it ~30s and the
callbacks carry it the rest of the way — the run settles to `PROCESSED` with a
bill per billed account:

```
 bill_run_id |  status   | ref_billing_account_id | subtotal | total_amount
-------------+-----------+------------------------+----------+--------------
 BRN00000001 | PROCESSED | BAN00000001            |   224.00 |       224.00
                         | BAN00000002            |   634.50 |       634.50
                         | BAN00000003            |   199.00 |       199.00
                         | BAN00000004            |     0.00 |         0.00
                         | BAN00000006            |   199.00 |       199.00
```

`BAN00000005` stays `EXCLUDED` (the partial-period account — Module Invariant
#26), and `BAN00000004` is billed at zero (the no-charges scenario). Watch the
engine side with:

```powershell
$U = "workflow-ops@billing.ops"; $P = "kestra_dev_dummy_Password1"
curl.exe -u "${U}:${P}" http://localhost:8085/api/v1/main/executions/<executionId>
```

A healthy run shows `SUCCESS` with every stage **and** every `signal_*_done`
green. If the stages pass but the signals are `WARNING`, see **Troubleshooting**.

> **Prefer a headless full-lifecycle proof?** `npm run billrun:live-kestra-smoke`
> drives the whole operator journey (trigger → PROCESSED → approve → post →
> distribute → COMPLETED, including a forced-failure/recovery leg) against the
> real deployed flows, gated to the `_SAMPLE_` seed graph. Run `db:seed-sample`
> first. On Windows/Node 24 the script prints its `reached COMPLETED` success
> line and then dies at process teardown with a libuv
> `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` and exits 1 — the
> journey passed; the crash is a Node shutdown race after the result. Confirm
> from the DB (`SELECT status FROM billing.bill_run` → `COMPLETED`).

---

## Running the stack day to day

After Part 1 (and Part 2, if you need the workflow engine), this is all you need.

### Start

```powershell
# 1. Database — always needed
docker compose start db

# 2. Workflow engine + blob store — only for rating / bill-run work
docker compose -f docker-compose.dev.yml -f workflow-management/dev/docker-compose.dev.yml up -d --no-deps workflow-engine azurite

# 3. App (host)
npm run dev
```

> ⚠️ **Use `up -d --no-deps`, not `start`, for the workflow engine.**
> `docker compose … start workflow-engine azurite` resolves the full dependency
> graph and aborts with `kestra-setup is missing dependency setup` (exit 1) — the
> `setup` / `kestra-setup` one-shot containers never exist in this host-based
> path, because step 9 created the engine with `--no-deps`. `up -d --no-deps`
> starts the existing containers in place and reuses all volumes and data. Give
> the engine ~30s to report healthy again.

`docker compose start db` (no `-f` overrides) is fine — `db` has no dependencies.

### Stop

```powershell
# App: Ctrl-C in the dev-server terminal
docker compose -f docker-compose.dev.yml -f workflow-management/dev/docker-compose.dev.yml stop azurite workflow-engine
docker compose stop db
```

`stop` halts the containers and **keeps all data**. Restart with the Start block;
nothing needs re-seeding, re-granting, or re-migrating.

### Check what's running

```powershell
docker compose ps
curl.exe http://localhost:3000/api/health
```

`docker compose ps` lists all three containers without the `-f` overrides — they
share one Compose project. `/api/health` returning `{"status":"ok","version":"local"}`
means the app process is up; it is a pure liveness probe and does **no** DB query
(so a transient DB blip can't trip it into a restart loop).

### After pulling new commits

```powershell
npm install          # if package.json changed

# New migrations are DDL — they must run as the superuser/owner, because the
# app_runtime DATABASE_URL in your .env has no DDL rights. Override it for this
# one command, then clear the override so the app reconnects as app_runtime:
$env:DATABASE_URL='postgresql://postgres:postgres@localhost:5432/enterprise_billing'
npm run db:migrate   # if db/migrations/ gained a file
Remove-Item Env:DATABASE_URL

npm run dev
```

Migrations are forward-only and idempotent. If a pulled migration adds a **new
schema**, also re-run `npm run db:bootstrap-roles` (Part 1 step 5) so
`app_runtime` picks up its grants on the new objects.

> **Edited-but-already-applied migrations.** Drizzle's migrator applies a
> migration only when its journal timestamp is newer than the last applied one;
> it does not re-check file hashes. So editing the SQL of a _previously applied_
> migration is silently skipped on an existing database (only a brand-new
> database picks it up). When that happens for a `system_config` row, bring an
> existing environment level with a one-off `UPDATE core.system_config … WHERE
> config_group = … AND config_key = …`.

---

## Tests, typecheck and lint

```powershell
npm run typecheck    # tsc --noEmit — clean
npm run lint         # eslint . — clean
```

### 🛑 Do not run `npm run test` against your dev database

`npm run test` is `vitest run && vitest run --config vitest.integration.config.ts`.
The second half is the **DB-gated** suite: `*.integration.test.ts` files (plus
`*.property.test.ts`) that each own the whole schema lifecycle and begin with
`DROP SCHEMA IF EXISTS "billing" CASCADE;` (and core, customer, product,
inventory, ordering, rating, drizzle) against whatever `DATABASE_URL` points at.
**Exporting your `.env` and running `npm run test` destroys everything Parts 1–3
built** — roles survive (they are cluster-level) but every table, grant and seed
row does not, and login breaks. One suite also drops the **`kestra`** database
outright, taking the running engine and every deployed flow with it. This is the
module convention
(`context/billing-management/specs/bm22-environmental-gate.md` §21).

### Running the suites safely

**Unit suite** — DB-free, but it needs the non-DB `.env` values in the process
environment. `vitest` does not read `.env`, and some files import `lib/config.ts`
at module load, so on a clean shell they abort with `AppError: Invalid
environment configuration.`

```powershell
# PowerShell — load .env, then run the DB-free half only
Get-Content .env | Where-Object { $_ -match '^\s*[^#\s][^=]*=' } | ForEach-Object {
  $k, $v = $_ -split '=', 2
  Set-Item -Path "Env:$($k.Trim())" -Value $v
}
npx vitest run
```

```bash
# Bash
set -a && . ./.env && set +a && npx vitest run
```

**Integration suite** — point `DATABASE_URL` at a throwaway database, **and stop
the workflow engine first**. Pointing `DATABASE_URL` somewhere disposable is
necessary but not sufficient: `tests/db/billrun-db-roles.integration.test.ts`'s
`afterAll` runs `DROP DATABASE IF EXISTS "kestra" WITH (FORCE);` — reaching
outside `DATABASE_URL` entirely — which terminates every live connection and
leaves Kestra's queues/flows/history dropped, so the engine exits 0 and **all
deployed flows are gone**. The same suite also rewrites the shared
`app_runtime` / `rating_runtime` / `billrun_runtime` passwords to a test value
(roles are cluster-level), so your dev app's next connection fails `28P01`.

So: either run the DB-gated suite against a **separate Postgres instance** (a
different container/port), or stop the engine, run the suite, then rebuild and
redeploy + restore passwords:

```powershell
docker compose -f docker-compose.dev.yml -f workflow-management/dev/docker-compose.dev.yml stop workflow-engine
# … run the suite …
npm run db:bootstrap-kestra-roles          # recreates the dropped `kestra` DB + role
docker exec -e PGPASSWORD=postgres enterprise-billing-app-db-1 `
  psql -U postgres -d enterprise_billing -c "ALTER ROLE kestra_engine WITH PASSWORD 'kestra_dev_password';"
docker compose -f docker-compose.dev.yml -f workflow-management/dev/docker-compose.dev.yml up -d --no-deps workflow-engine
docker compose -f docker-compose.dev.yml -f workflow-management/dev/docker-compose.dev.yml run --rm --no-deps flow-deploy
```

Restore the shared role passwords with the `ALTER ROLE` block in
**Troubleshooting**, and restart `npm run dev` so the pool reconnects. Your
`enterprise_billing` dev database's **data** is untouched by any of this — only
the `kestra` database, the cluster's role passwords, and whatever `DATABASE_URL`
names are at risk.

Create the throwaway database (once), then run the DB-gated half against **only**
it. The integration config supplies its own `BETTER_AUTH_*`/`BOOTSTRAP_ADMIN_*`
fixtures, so `DATABASE_URL` is the only variable to set — do **not** export your
`.env` for this half:

```powershell
docker exec -e PGPASSWORD=postgres enterprise-billing-app-db-1 `
  psql -U postgres -d postgres -c "CREATE DATABASE enterprise_billing_test;"
$env:DATABASE_URL='postgresql://postgres:postgres@localhost:5432/enterprise_billing_test'
npx vitest run --config vitest.integration.config.ts
Remove-Item Env:DATABASE_URL
```

```bash
DATABASE_URL='postgresql://postgres:postgres@localhost:5432/enterprise_billing_test' \
  npx vitest run --config vitest.integration.config.ts
```

The suites run serially (`fileParallelism: false`) and each re-migrates the
schema, so the full DB-gated run takes ~5 min.

> The config promises it will "skip loudly when `DATABASE_URL` is unset", but
> `db/client.ts` imports `lib/config.ts` at module load and throws first, so each
> DB-gated file *errors* rather than skipping. Set `DATABASE_URL` (to a
> disposable database) rather than relying on the skip.

---

## Credentials & endpoints (local dev)

All values below are **local-only dummies** — never used in any real environment
(production sources them from Key Vault via Managed Identity).

| Item | Value |
| --- | --- |
| App | http://localhost:3000 · `admin@billing.com` / `16Chars-Password` |
| Kestra UI | http://localhost:8085/ui/ · `workflow-ops@billing.ops` / `kestra_dev_dummy_Password1` |
| Postgres superuser | `postgres` / `postgres` @ `localhost:5432/enterprise_billing` |
| `app_runtime` / `app_migrate` | `apprun_local_dev_pw` |
| `billrun_runtime` | `billrun_runtime_dev_password` (must match `SECRET_BILLRUN_RUNTIME_PASSWORD`) |
| `rating_runtime` | `rating_runtime_dev_password` (must match `SECRET_RATING_RUNTIME_PASSWORD`) |
| `kestra_engine` | `kestra_dev_password` (must match `KESTRA_DATASOURCES_POSTGRES_PASSWORD`) |
| `BILLRUN_APP_TOKEN` | `billrun_dev_app_token_change_me_0123456789` (decoded `SECRET_BILLRUN_APP_TOKEN`) |
| Azurite blob | Microsoft's published well-known dev account/key (`devstoreaccount1`) |

The `must match` values all live in the committed
`workflow-management/dev/.env.example`, which the Kestra container reads via
`env_file`. Change them there and re-run the `ALTER ROLE`s together, or not at
all.

---

## Troubleshooting

**Docker commands fail with `failed to connect to the docker API at
npipe:////./pipe/dockerDesktopLinuxEngine`.** Docker Desktop isn't running.

**Port 3000 is already in use.** A stray dev server is still running. Kill it by
port:

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id $_ -Force }
```

> Do not use a `CommandLine -match 'next dev'` filter — `next dev` spawns a
> separate `start-server.js` worker that actually holds the port.

**The app starts but every page 500s.** The DB container is stopped, or the app
is connecting as a role whose password was never set — re-run Part 1 step 5.

**`POST /api/billrun/...` returns 404 (an HTML page, not JSON), but
`/api/billrun/{runId}/status` works.** A stale Turbopack cache: the dev server's
route manifest can miss the more deeply nested API routes while resolving the
shallow one. Stop the dev server, delete `.next`, restart:

```powershell
Remove-Item -Recurse -Force .next
npm run dev
```

All three routes should then answer **401** to an unauthenticated POST.

**Callbacks return 500 with `PostgresError ... code 28P01`.** `28P01` is
"password authentication failed" — the app is holding pooled connections opened
with a password that has since changed, almost always because the DB-gated test
suite rewrote the shared role passwords. Restore them, then **restart
`npm run dev`** so the pool reconnects (fixing the password alone is not enough
while the old pool is alive):

```powershell
docker exec -e PGPASSWORD=postgres enterprise-billing-app-db-1 `
  psql -U postgres -d enterprise_billing -v ON_ERROR_STOP=1 `
  -c "ALTER ROLE app_runtime      WITH PASSWORD 'apprun_local_dev_pw';" `
  -c "ALTER ROLE app_migrate      WITH PASSWORD 'apprun_local_dev_pw';" `
  -c "ALTER ROLE billrun_runtime  WITH PASSWORD 'billrun_runtime_dev_password';" `
  -c "ALTER ROLE rating_runtime   WITH PASSWORD 'rating_runtime_dev_password';" `
  -c "ALTER ROLE kestra_engine    WITH PASSWORD 'kestra_dev_password';"
```

**Stages succeed but every `signal_*_done` task is `WARNING`.** Read the
execution log for the HTTP status the app returned: `401` means
`BILLRUN_APP_TOKEN` does not match the engine's decoded `SECRET_BILLRUN_APP_TOKEN`
(Part 2 step 11); `404` is the stale-cache case above; `500` with `28P01` is the
password case above; `UnknownHostException: app` means the engine was created
before the `extra_hosts` mapping — recreate it with `up -d --no-deps
--force-recreate workflow-engine`.

**The workflow engine exited on its own (exit 0) and its flows are gone.** Its
logs show `SQLSTATE(08006)` then `Fatal error while polling … Initiating
shutdown`. Something dropped the `kestra` database out from under it — in
practice, the DB-gated test suite. Recover with the `db:bootstrap-kestra-roles` →
`ALTER ROLE` → `up -d --no-deps` → `flow-deploy` sequence under **Tests**.

**Kestra is up but executions never start.** Check the app is pointed at it
(Part 2 step 11) and that `BILLRUN_ENGINE_LOOPBACK=true` is set in `.env`.

**Kestra executions start but every DB task fails to authenticate.** The
`billrun_runtime` (or `rating_runtime`) password doesn't match
`workflow-management/dev/.env.example` — re-run the `ALTER ROLE`s in Part 2 step 8.

**`docker compose … start workflow-engine` exits 1 with `kestra-setup is missing
dependency setup`.** Expected on this topology — use `up -d --no-deps` instead.

**Kestra login 401s after changing its Basic-Auth values.** Kestra 1.3.35
validates the configured username/password at startup and silently discards the
whole credential if the username isn't an email address or the password isn't ≥8
chars with an upper, a lower and a digit. The rejection reason is recorded in the
`kestra` database's `settings` table under
`kestra.server.authentication-configuration-error`. Detail:
`workflow-management/dev/.env.example`.

**`billrun:live-kestra-smoke` prints `reached COMPLETED` then exits 1 with a
libuv `UV_HANDLE_CLOSING` assertion.** A Node/libuv teardown race on Windows that
fires *after* the journey succeeds — not a functional failure. Confirm from the
DB: `SELECT status FROM billing.bill_run` should show `COMPLETED`.

**Older checkouts — Windows CRLF breaks SQL-boundary tests.** Without
`.gitattributes`, Git for Windows' `core.autocrlf=true` checks `.sql` files out
as CRLF, which breaks nine byte-exact guardrail tests. Re-normalize:

```bash
git ls-files -z '*.sql' | xargs -0 rm -f && git checkout -- '*.sql'
```

---

## Useful scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Next.js dev server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | `eslint .` |
| `npm run test` | unit **+ DB-gated** suites — ⛔ never run as-is against your dev DB; see "Tests" |
| `npx vitest run` | DB-free unit suite (export `.env` first) |
| `npm run db:setup` | migrate + partman + full baseline seed |
| `npm run db:migrate` | apply any new forward migrations (idempotent) |
| `npm run db:seed-sample` | `_SAMPLE_*` bill-run demo scenario — run as **superuser**, see Part 3 |
| `npm run db:bootstrap-roles` | create `app_runtime`/`app_migrate` + grants |
| `npm run db:bootstrap-rating-roles` | create `rating_runtime` + grants |
| `npm run db:bootstrap-billrun-roles` | create `billrun_runtime` + grants |
| `npm run db:bootstrap-kestra-roles` | create the `kestra` DB + `kestra_engine` role |
| `npm run dev:azurite-init` | create the `kestra-internal` + `invoices` blob containers (idempotent) |
| `npm run billrun:live-kestra-smoke` | headless full `SCHEDULED → COMPLETED` journey against real Kestra (see Part 3) |
| `npm run validate:env` | check `.env.example` still satisfies the config schema |
| `docker compose ps` | what's running, and on which ports |
| `curl http://localhost:3000/api/health` | app liveness (no DB query) |

## Learn more

- Next.js docs: https://nextjs.org/docs
- Workflow-management architecture: `context/workflow-management/wfm-architecture.md`
- Module context: `context/billing-management/` and `context/rating-management/`
- DB role details: `infra/docs/db-role-verification.md`
- Bill-run flow placeholders: `workflow-management/flows/bill-run-processor/README.md`
