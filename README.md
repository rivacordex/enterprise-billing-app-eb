# Enterprise Billing App

Next.js + Drizzle + PostgreSQL billing platform, with a **Kestra** workflow
engine (the shared `workflow-engine`) for the rating and bill-run pipelines.

This README is the **complete installation and operations guide for the local
development environment** — how to set up the database, the app, and the
workflow-management (Kestra) layer from nothing, and how to run them day to day.
The sequence in Parts 1–2 is the one that was last executed end-to-end, so
following it top-to-bottom on a clean machine produces a working stack.

> **Last verified end-to-end: 2026-09-17** on Windows 11 / Docker 29.4.3 /
> Compose v5.1.3 / Node 24.16.0, from an empty Docker state (no
> `enterprise-billing-app-*` containers or volumes). Every command below was
> executed in that order, and a `_SAMPLE_` bill run was driven through the
> **full `SCHEDULED → COMPLETED` lifecycle** — processed, approved, posted to
> the ledger (4 INV documents), and distributed (4 invoice PDFs + the run report
> delivered to the `loopback` sink). Where the previous revision of this guide
> diverged from what actually happens, the text has been corrected and the
> divergence called out; the repository defects that run surfaced are fixed and
> described under **Fixed while writing this guide**. Read **Tests, typecheck
> and lint** before you run `npm run test`: its second half wipes whatever
> database `DATABASE_URL` names, and takes the workflow engine with it.

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
>
> **Consequence worth knowing up front:** in this host-based path there is no
> `app` **container**, so anything inside the Docker network that addresses the
> app by its Compose service name (`http://app:3000`) — as the bill-run flows'
> M2M callbacks do — would not reach it. The local-dev compose closes that gap
> by mapping `app` to the Docker host gateway for the engine; see Part 2 step 11.

---

## Prerequisites

- **Docker Desktop** (Compose v2 or newer; verified on Compose v5). Start it and
  wait for the engine before running any `docker` command — a stopped Docker
  Desktop fails with `failed to connect to the docker API at
  npipe:////./pipe/dockerDesktopLinuxEngine`.
- **Node.js ≥ 22** (`node -v`). `.nvmrc` pins 22; Node 24 also works.
- **Windows/PowerShell** is assumed below (this repo is developed on Windows).
  Bash equivalents are noted where the syntax differs. On Windows, prefer the
  **PowerShell** shell for `docker run -v` / `docker exec` / `docker cp` with
  container-absolute paths — Git-Bash (MSYS) silently mangles paths like
  `/etc/caddy/Caddyfile` into `E:/Program Files/Git/etc/...` and flags like
  `taskkill /PID` into a path.
- **Git line endings.** `.gitattributes` pins `*.sql` to LF, which is what keeps
  three byte-exact test files passing under Git for Windows' default
  `core.autocrlf=true`. A checkout predating that file needs re-normalizing —
  see **Fixed while writing this guide → 3**.

---

## Part 1 — Database + app

### 1. Install dependencies

```powershell
npm install
```

`npm audit` reports pre-existing advisories in the transitive tree; they do not
affect local setup and are not part of this guide.

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

> **`BOOTSTRAP_DATABASE_URL` is not in `.env.example`** — copying the template
> does not give you that line, and the role/partman bootstrap scripts read it
> directly. Add it by hand, as shown above.
>
> Everything else in the block above *is* in the template; you are editing
> values, not adding keys. `BILLRUN_BLOB_CONNECTION_STRING` (Part 3) also ships
> uncommented in the template, so it is already correct in your `.env` from this
> step — Part 3 step 12 is a no-op unless you changed it.

> Never commit a real Entra `MICROSOFT_CLIENT_SECRET`, tenant/client ID, or a
> real Postgres DSN into `.env` — even though `.env` is git-ignored, keeping it
> dummies-only keeps the repo publish-safe.

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
> session. Open a new terminal (or `Remove-Item Env:DATABASE_URL`) before
> running the app so it connects as `app_runtime` again.
>
> The override works even though every `db:*` script passes `--env-file=.env`:
> Node's `--env-file` does not overwrite variables already present in the
> process environment.

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

> The dev console logs CSP `style-src 'self'` violations for inline styles.
> They are dev-mode noise (Next injects inline styles that the app's production
> CSP header also governs) and do not affect rendering.

---

## Part 2 — Workflow management (Kestra) + rating/bill-run flows

> **Local topology.** The base deployment runs all functions on **one** shared
> Kestra instance (`workflow-engine`), hosting both the `rating` and `billrun`
> namespaces (`context/workflow-management/wfm-architecture.md` §5, "collapsed"
> topology). Rating's four flows are the real definitions; the bill-run flows
> deployed here are the **local-dev placeholders**
> (`workflow-management/flows/bill-run-*/local-dev/`), which now carry real
> processing SQL and real callback tasks — but see step 11 for what that does
> and does not get you locally.

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

Now set the role passwords. ⚠️ **These three values are not free choices** —
each one must match the value the Kestra container reads from the committed
`workflow-management/dev/.env.example`, which is the single source the flows and
the engine datasource use:

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

> **Corrected 2026-09-17.** Earlier revisions of this guide told you to set
> `billrun_runtime` to `billrun_local_dev_pw` and never mentioned
> `rating_runtime` at all. `billrun_local_dev_pw` is read by nothing in the
> repository — with it set, every psql task in `bill_run_processing` fails
> password authentication. Use the table above.

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

Then create the blob containers — **required, once per Azurite volume**:

```powershell
npm run dev:azurite-init
```

> ⚠️ **Don't skip this.** Azurite does not auto-create containers and neither
> does Kestra — it PUTs into `kestra-internal` and takes the 404. Kestra's
> **internal storage** is where every file-producing task parks its output for
> the next task to read (`kestra:///…` URIs), so without that container the
> bill-run **distribution** flow downloads each invoice PDF perfectly (Azurite
> logs a `206`) and then dies writing the result into its own storage —
> surfacing as a bare `BlobStorageException: Status code 404` that reads like a
> missing invoice. The two containers are distinct: `invoices` is the **app's**
> durable artifact store (PDFs + run report, checksummed, registered in
> `bill_run_invoices`); `kestra-internal` is the **engine's** transient
> task-to-task scratch space, named by `KESTRA_STORAGE_AZURE_CONTAINER` in the
> shared `kestra.yml` — so it exists in the deployed stack too, not just here.

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
BILLRUN_APP_TOKEN=billrun_dev_app_token_change_me_0123456789
```

(`BILLRUN_ENGINE_NAMESPACE=billrun` already ships in `.env.example`; the other
four are new lines.)

> ⚠️ **`BILLRUN_APP_TOKEN` is NOT a free choice — do not generate a random one.**
> It is the *inbound* M2M bearer the engine presents on every callback, so it
> must equal what the engine sends: the base64-**decoded**
> `SECRET_BILLRUN_APP_TOKEN` from the committed
> `workflow-management/dev/.env.example` (Kestra OSS's env secret backend
> base64-decodes every `SECRET_<NAME>`). That decodes to exactly the value
> above — verify with:
>
> ```bash
> node -e "console.log(Buffer.from('YmlsbHJ1bl9kZXZfYXBwX3Rva2VuX2NoYW5nZV9tZV8wMTIzNDU2Nzg5','base64').toString())"
> ```
>
> Earlier revisions of this guide said to generate a random 36-byte token here.
> That value matches nothing, so the app rejects **every** stage callback with
> 401 (it is fail-closed) and the run never leaves `PROCESSING`.

Restart the dev server (plain — nothing extra needed):

```powershell
npm run dev
```

> The HTTPS-only rule still holds for any **non-loopback** host: a remote
> `http://` URL — or `BILLRUN_ENGINE_LOOPBACK=true` pointed at a non-loopback
> host — fails fast at boot, so the flag can never send Basic-Auth to a remote
> engine in the clear. In Azure the flag is left unset (Container Apps ingress
> provides HTTPS).

**What you get locally.** The full processing leg works: triggering a run
reaches real Kestra, every account runs all five stages (validation →
collection → aggregation → taxation → verification) as `billrun_runtime`
against the real database, each stage POSTs its `DONE` callback back to the
app, and the run settles to **`PROCESSED`** with real `customer_bill` rows.
Verified 2026-09-17 on the `_SAMPLE_` `ci` seed: execution `SUCCESS`, 5
accounts × 5 stages × 5 signals all green, `BRN00000001` `PROCESSING →
PROCESSED`.

Two things had to be fixed to get there; both are now in the repo, so a fresh
clone gets this behaviour:

1. **The flow read the loop value the wrong way.** `bill_run_processing`
   referenced `{{ taskrun.value }}` from inside the `account_pipeline`
   Sequential nested in the `per_account` ForEach. A ForEach value is **not**
   inherited by descendants, so on the pinned engine every account died at the
   first stage with `IllegalVariableEvaluationException: Unable to find
   'value'`. The flow now uses `{{ parents[0].taskrun.value }}` — the same
   convention the distributor already documents.
2. **The engine could not reach a host-run app.** The callbacks POST to
   `http://app:3000/...` (the Compose service name — correct for the deployed
   and fully-containerized stacks), but this host-based path runs the app on the
   host with no `app` container, so every callback died with
   `java.net.UnknownHostException: app`. The local-dev compose now maps
   `app → host-gateway` for the engine (`extra_hosts`), which fixes it **without
   touching a single flow URI**, so the deployed contract is unchanged. See the
   comment in `workflow-management/dev/docker-compose.dev.yml` for the one
   trade-off.

**Distribution works too, to the `loopback` target.** Approve → post →
distribute completes the full `SCHEDULED → COMPLETED` lifecycle locally: the
flow downloads each stored artifact from Azurite and writes it to the engine's
own mounted sink, inspectable on the host under
`workflow-management/dev/distribution/`. Verified 2026-09-17: 4 invoice PDFs +
the run report CSV all `DELIVERED`, run `COMPLETED`.

The **`sftp`** target is the part this guide does not cover — it needs the SFTP
endpoint and key material set up (`workflow-management/dev/sftp/README.md`).
`loopback` is the default and needs none of that.

> Earlier revisions attributed a stalled run to "status callbacks are still
> stubbed (logged, not sent)". That was doubly stale: bm36 replaced the `Log`
> stubs with real POSTs, and the actual blockers were the two above.

---

## Part 3 — Optional: the `_SAMPLE_` bill-run demo scenario

Seeds an unmistakably-fake `_SAMPLE_` customer + charges so you can click a bill
run through the UI end-to-end (real Kestra `executionId`).

### 12. Point at the local blob store

`.env.example` already ships this line uncommented, so after Part 1 step 2 your
`.env` already has it. Confirm it is present and points at `127.0.0.1:10000`,
and restart `npm run dev` if you change it:

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

> Earlier revisions described "3 billing accounts (2 full-period + 1 partial)
> and 4 `udr_rated` charges". The `ci` profile above is what the script
> actually seeds.

### 14. Trigger it in the UI

Open the **Bill Runs** page (loading it lazily materializes the due
`SCHEDULED` runs — you should see `BRN00000001` on "Monthly – Day 1" and
`BRN00000002` on "Monthly – Day 15"). Press **Run** on the **"Monthly – Day 1"**
cycle — that is the cycle the `_SAMPLE_` accounts are on — then **Confirm Run**
in the dialog.

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

A real execution id means the app→Kestra leg is wired. Give the execution ~30s
and the callbacks will carry it the rest of the way — the run settles to
`PROCESSED` with a bill per billed account:

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

A healthy run shows `SUCCESS` with every `validation`/`collection`/
`aggregation`/`taxation`/`verification` **and** every `signal_*_done` green. If
the stages pass but the signals are `WARNING`, see **Troubleshooting**.

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
> graph and aborts with `kestra-setup is missing dependency setup` (exit 1),
> leaving the engine stopped — the `setup` / `kestra-setup` one-shot containers
> never exist in this host-based path, because step 9 created the engine with
> `--no-deps`. `up -d --no-deps` starts the existing containers in place and
> reuses all volumes and data. Give the engine ~30s to report healthy again.

`docker compose start db` (no `-f` overrides) is fine — `db` has no dependencies.

### Stop

```powershell
# App: Ctrl-C in the dev-server terminal
docker compose -f docker-compose.dev.yml -f workflow-management/dev/docker-compose.dev.yml stop azurite workflow-engine
docker compose stop db
```

`stop` halts the containers and **keeps all data**. Restart with the Start
block above; nothing needs re-seeding, re-granting, or re-migrating. (Verified:
a full stop/start cycle preserves roles, grants, seeds and the Kestra flows.)

### Check what's running

```powershell
docker compose ps
curl.exe http://localhost:3000/api/health
```

`docker compose ps` lists all three containers without needing the `-f`
overrides — they share one Compose project.

`/api/health` returning `{"status":"ok","version":"local"}` means the app process
is up and serving. It is a pure liveness probe and deliberately does **no** DB
query (so a transient DB blip can't trip it into a restart loop) — a dedicated
DB-connectivity check (`/api/health/db`) is reserved but not yet implemented. For
a deeper check that the workflow engine is genuinely reachable and executing,
trigger a real execution:

```powershell
$U = "workflow-ops@billing.ops"; $P = "kestra_dev_dummy_Password1"
curl.exe -u "${U}:${P}" -X POST -F 'ban_ids=["BAN0001","BAN0002"]' `
  http://localhost:8085/api/v1/main/executions/billrun/bill_run_processing
```

A `200` with a JSON body containing an `id` and `"state":{"current":"CREATED"}`
proves the engine accepted and scheduled the execution (the flow's other inputs
fall back to their defaults). The point of this check is engine reachability;
the execution itself will fail its stages, because the default `bill_run_id`
(`BRN-DEMO`) and the `BAN0001`/`BAN0002` ids above do not exist. For a run that
actually completes, trigger a real one from the UI (Part 3 step 14).

To inspect any execution's task states:

```powershell
$U = "workflow-ops@billing.ops"; $P = "kestra_dev_dummy_Password1"
curl.exe -u "${U}:${P}" http://localhost:8085/api/v1/main/executions/<executionId>
curl.exe -u "${U}:${P}" http://localhost:8085/api/v1/main/logs/<executionId>/download
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

---

## Tests, typecheck and lint

```powershell
npm run typecheck    # tsc --noEmit — clean
npm run lint         # eslint . — clean
```

### 🛑 Do not run `npm run test` against your dev database

`npm run test` is `vitest run && vitest run --config vitest.integration.config.ts`.
The second half is the **DB-gated** suite: 91 `*.integration.test.ts` files (plus
the `*.property.test.ts` fast-check suites) that each own the whole schema
lifecycle and begin with

```sql
DROP SCHEMA IF EXISTS "billing" CASCADE;   -- … and core, customer, product,
                                            --    inventory, ordering, rating, drizzle
```

against whatever `DATABASE_URL` points at. **Exporting your `.env` and running
`npm run test` therefore destroys everything Parts 1–3 just built** — roles
survive (they are cluster-level) but every table, grant and seed row does not,
and login breaks. One suite also drops the **`kestra`** database outright,
whatever `DATABASE_URL` says, taking the running engine and every deployed flow
with it (see "Running the suites safely"). This is the module's established
convention
(`context/billing-management/specs/bm22-environmental-gate.md` §21: "DB-gated
suites run on a disposable database, never the shared dev DB"); it simply was
never written down here.

### Running the suites safely

**Unit suite** — DB-free, but it does need the non-DB `.env` values in the
process environment. `vitest` does not read `.env` (unlike the `db:*` scripts,
which pass `--env-file=.env`), and `tests/services/billing/trigger-run.service.test.ts`
imports `lib/config.ts` at module load, so on a clean shell that file aborts
with `AppError: Invalid environment configuration.`

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

Expected with the environment loaded: **315 of 315 files, 3137 tests, all
passing** (verified 2026-09-17). Without the env load, `trigger-run.service`
aborts at import; without `.gitattributes`, nine more fail on Windows.

**Integration suite** — point `DATABASE_URL` at a throwaway database, **and stop
the workflow engine first**. Pointing `DATABASE_URL` somewhere disposable is
necessary but *not* sufficient: `tests/db/billrun-db-roles.integration.test.ts`'s
`afterAll` reaches outside `DATABASE_URL` entirely and runs

```sql
DROP DATABASE IF EXISTS "kestra" WITH (FORCE);
```

`WITH (FORCE)` terminates every live connection to the `kestra` database before
dropping it. That database *is* Kestra's world — queues, flow definitions,
execution history. The observed result (2026-09-17, 13:15:40 UTC) was every
Hikari connection breaking at once with `SQLSTATE(08006)`, every queue poller
logging `Fatal error while polling … Initiating shutdown`, and the engine
container exiting 0 — with the `kestra` database left dropped, so **all deployed
flows were gone**.

So: either run the DB-gated suite against a **separate Postgres instance** (a
different container/port, not just a different database in this one), or stop
the engine, run the suite, then rebuild and redeploy:

```powershell
docker compose -f docker-compose.dev.yml -f workflow-management/dev/docker-compose.dev.yml stop workflow-engine
# … run the suite …
npm run db:bootstrap-kestra-roles          # recreates the dropped `kestra` DB + role
docker exec -e PGPASSWORD=postgres enterprise-billing-app-db-1 `
  psql -U postgres -d enterprise_billing -c "ALTER ROLE kestra_engine WITH PASSWORD 'kestra_dev_password';"
docker compose -f docker-compose.dev.yml -f workflow-management/dev/docker-compose.dev.yml up -d --no-deps workflow-engine
docker compose -f docker-compose.dev.yml -f workflow-management/dev/docker-compose.dev.yml run --rm --no-deps flow-deploy
```

**It also rewrites the shared role passwords.** The same suite runs
`ALTER ROLE app_runtime / rating_runtime / billrun_runtime WITH PASSWORD
'bm14-test-only-pw'`. Roles are **cluster-level**, so this silently
re-credentials your dev stack: the app's next connection fails `28P01` and every
flow DB task fails `password authentication failed`. Restore them with the
`ALTER ROLE` block in **Troubleshooting**, and restart `npm run dev` so the
connection pool picks the change up.

Your `enterprise_billing` dev database's **data** is untouched by any of this —
only the `kestra` database, the cluster's role passwords, and whatever
`DATABASE_URL` names are at risk.

Create the throwaway database (once):

```powershell
docker exec -e PGPASSWORD=postgres enterprise-billing-app-db-1 `
  psql -U postgres -d postgres -c "CREATE DATABASE enterprise_billing_test;"
```

Then run the DB-gated half against it, and **only** it. The integration config
supplies its own `BETTER_AUTH_*`/`BOOTSTRAP_ADMIN_*` fixtures, so `DATABASE_URL`
is the only variable you set — do **not** export your `.env` for this half, or
you will hand it your dev DSN:

```powershell
$env:DATABASE_URL='postgresql://postgres:postgres@localhost:5432/enterprise_billing_test'
npx vitest run --config vitest.integration.config.ts
Remove-Item Env:DATABASE_URL
```

```bash
DATABASE_URL='postgresql://postgres:postgres@localhost:5432/enterprise_billing_test' \
  npx vitest run --config vitest.integration.config.ts
```

The suites run serially (`fileParallelism: false`) and each re-migrates the
schema, so the full DB-gated run takes a while (~5 min for all 93 files).

Result on 2026-09-17, with `DATABASE_URL` as the **only** variable set:
**89 files passed, 2 skipped, 2 failed** (813 tests passed, 68 skipped, 2
failed). Both failures are the full-journey E2E suites —
`tests/db/billing-e2e-happy-path.integration.test.ts` and
`tests/db/billrun-phase3-journey.integration.test.ts` — failing the same
post→distribute assertion, `expected 'INVOICED' to be 'DISTRIBUTING'`: posting
lands the run at `INVOICED` but the post-commit `triggerDistribution` does not
advance it. These two suites are also sensitive to ambient environment beyond
`DATABASE_URL` — re-running `billrun-phase3-journey` with a dev `.env` also
exported fails earlier instead (line 568). The progress tracker lists this
full DB-gated run as a gated verification step that had not yet been executed,
so treat the two failures as untriaged rather than as a regression you caused.

> The config's comment promises it will "skip loudly when `DATABASE_URL` is
> unset", and each suite does carry a `describe.skipIf(!DATABASE_URL)` — but
> that never gets a chance to fire: `db/client.ts` imports `lib/config.ts` at
> module load, which throws `Invalid environment configuration.` first, so every
> DB-gated file *errors* rather than skipping. Set `DATABASE_URL` (to a
> disposable database) rather than relying on the skip.

---

## Fixed while writing this guide

Driving this guide end-to-end on 2026-09-17 — all the way through approve, post
and distribute — surfaced six repository-level defects. **All six are fixed in
the repo.** They are recorded here because the symptoms are distinctive and
mostly point somewhere other than the cause, and you may still meet them in an
older checkout or a stale environment.

Four of the six lived in code paths that had never actually been executed
locally: the processing flow's loop values, the whole distribution flow, and the
Distribution tab's render once it finally had rows to show.

### 1. `bill_run_processing` failed its first stage on Kestra 1.3.35

**Symptom.** Every execution ended `RETRYING`/failed with
`per_account → account_pipeline → validation` all `FAILED`, and:

```
ERROR Unable to find `value` used in the expression `set -eu ...` at line 18
io.kestra.core.exceptions.IllegalVariableEvaluationException
```

**Cause.** The flow read `{{ taskrun.value }}` from tasks nested inside the
bm36 `account_pipeline` `Sequential`, which sits inside the `per_account`
`ForEach`. The file's own comment asserted that "the enclosing ForEach value is
inherited by descendants" — it is not. Probed directly against the pinned
engine: from inside the wrap, `taskrun.value` is unresolvable,
`parents[0].taskrun.value` is the account id (in the stage tasks **and** in the
`errors` handler), and `parents[1]` does not exist at that depth.

**Fix.** All 15 references now use `{{ parents[0].taskrun.value }}`, matching
the convention `bill_run_distribution.yml` already documents, and the misleading
comment is corrected.

### 2. Local callbacks could not reach a host-run app

**Symptom.** Stages succeeded; every `signal_*_done` task ended `WARNING` with
`java.net.UnknownHostException: app`, and the run sat at `PROCESSING`.

**Cause.** The flows POST to `http://app:3000/api/billrun/...` — the Compose
service name. This guide's host-based path runs the app on the host and starts
the engine `--no-deps`, so no `app` container exists.

**Fix.** `workflow-management/dev/docker-compose.dev.yml` maps `app` to the
Docker host gateway for the `workflow-engine` service. No flow URI changed, so
the deployed contract is byte-identical.

### 3. Windows CRLF broke 9 tests in 3 files

**Symptom.** With the environment loaded, these failed on Windows only:
`billing-customer-bill-line-replace-boundary` (5),
`billrun-inventory-write-boundary` (2), `pgledger/transform` (2).

**Cause.** No `.gitattributes`, so Git for Windows' default
`core.autocrlf=true` checked `.sql` files out as CRLF. The guardrail helper
strips SQL comments with `line.replace(/--.*$/, "")` after `split("
")` — but
`` is a JavaScript regex *line terminator*, so `.` never matches it and `$`
(no `m` flag) never matches before it. The strip silently no-opped, and the
read-only-boundary prose in `billrun-db-roles.sql` (which legitimately names
INSERT/UPDATE/DELETE) reached the
`not.toMatch(/(INSERT|UPDATE|DELETE|TRUNCATE)/i)` assertion.

**Fix.** `.gitattributes` pins `*.sql text eol=lf`. No assertion was weakened.
If you have an older checkout, re-normalize with:

```bash
git ls-files -z '*.sql' | xargs -0 rm -f && git checkout -- '*.sql'
```

### 4. `bill_run_distribution` had three independent defects

Distribution had never actually been executed locally, so the whole flow was
unverified. All three are fixed:

1. **`parents[1]` does not exist at that depth.** The flow read the target as
   `parents[1].taskrun.value`. Probed against the pinned engine:
   `taskrun.value` IS the artifact and `parents[0]` IS the target. Every run
   died on `upload_local`'s `runIf` with `PebbleException: Could not perform not
   equals comparison`, so nothing was delivered and no outcome was POSTed.
2. **Task outputs inside a nested ForEach are keyed by BOTH loop values.**
   `{{ outputs.download.blob.uri }}` is unresolvable there; the real shape is
   `outputs.<task>[<outer value>][<inner value>]`. Fixed at all three sites —
   both uploads and the outcome POST's DELIVERED/FAILED decision, which had
   been silently evaluating to FAILED for every artifact.
3. **`kestra-internal` was never created** — see Part 2 step 9.

### 5. The Distribution tab crashed whenever it had rows

`components/billing/distribution-tab.tsx` is a server component but imported
`failedArtifactRefsFromRows` from a `"use client"` module, which Next refuses at
runtime ("Attempted to call … from the server but … is on the client"),
dropping the whole run-detail page to its error boundary. Invisible until
distribution produced its first `bill_run_distribution` rows. The helper is a
pure function over plain rows, so it now lives in the server component.

### 6. Azurite was not persisting to its volume

The compose service mounted `azurite_data:/data` but ran without `-l /data`, so
Azurite wrote to `/opt/azurite` **inside the container** — every rendered
invoice PDF and all of Kestra's internal storage sat in the container layer and
would vanish on any recreate. Now fixed with `-l /data`.

> If you are migrating an existing Azurite store onto the volume, copy
> `__azurite_db_blob__.json`, `__azurite_db_blob_extent__.json` **and**
> `__blobstorage__/` together. Copying the blob DB without the extent DB leaves
> the metadata pointing at extents the new instance cannot resolve, and every
> blob GET returns `500`.

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
| `billrun_runtime` | `billrun_runtime_dev_password` (must match `SECRET_BILLRUN_RUNTIME_PASSWORD`) |
| `rating_runtime` | `rating_runtime_dev_password` (must match `SECRET_RATING_RUNTIME_PASSWORD`) |
| `kestra_engine` | `kestra_dev_password` (must match `KESTRA_DATASOURCES_POSTGRES_PASSWORD`) |
| Azurite blob | Microsoft's published well-known dev account/key (`devstoreaccount1`) |

The three `must match` values all live in the committed
`workflow-management/dev/.env.example`, which the Kestra container reads via
`env_file`. Change them there and re-run the `ALTER ROLE`s together, or not at
all.

---

## Troubleshooting

**Docker commands fail with `failed to connect to the docker API at
npipe:////./pipe/dockerDesktopLinuxEngine`.** Docker Desktop isn't running.
Launch it and wait for the whale icon to settle before retrying.

**Port 3000 is already in use.** A stray dev server is still running. Kill it by
port — this is reliable regardless of how the server was launched:

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id $_ -Force }
```

Bash: `pkill -f "next dev"` (or kill the PID from `netstat -ano | grep :3000`).

> Do not use the old `CommandLine -match 'next dev'` filter — `next dev` spawns
> a separate `start-server.js` worker that actually holds the port, and the
> launcher's command line renders as `"…\node_modules\…\next" dev` (a quote
> between `next` and `dev`), so that pattern matches neither process.

**The app starts but every page 500s.** The database container is stopped, or
the app is connecting as a role whose password was never set — re-run Part 1
step 5.

**`POST /api/billrun/...` returns 404 (an HTML page, not JSON), but
`/api/billrun/{runId}/status` works.** A stale Turbopack cache: the dev server's
route manifest can miss the more deeply nested API routes
(`.../stage/{stage}/complete`, `.../distribution/outcome`) while resolving the
shallow one. The 404 is Next's own, so nothing reaches the handler and every
engine callback fails. Stop the dev server, delete the cache, restart:

```powershell
Remove-Item -Recurse -Force .next
npm run dev
```

All three routes should then answer **401** to an unauthenticated POST — that is
the healthy response, meaning the route matched and the bearer check ran.

**Callbacks return 500 with `PostgresError ... code 28P01` in the dev-server
log.** `28P01` is "password authentication failed". The app is holding pooled
connections opened with a password that has since changed — almost always
because the DB-gated test suite rewrote the shared role passwords (see
"Tests"). Restore them, then **restart `npm run dev`** so the pool reconnects;
fixing the password alone is not enough while the old pool is alive:

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
before the `extra_hosts` mapping — recreate it with
`up -d --no-deps --force-recreate workflow-engine`.

**The workflow engine exited on its own (exit 0) and its flows are gone.** Its
logs will show `SQLSTATE(08006)` on every connection followed by `Fatal error
while polling … Initiating shutdown`. Something dropped the `kestra` database
out from under it — in practice, the DB-gated test suite (see "Tests"). Recover
with the `db:bootstrap-kestra-roles` → `ALTER ROLE` → `up -d --no-deps` →
`flow-deploy` sequence in that section. Kestra self-terminates by design when
its queue database becomes unreachable; it does not retry.

**Kestra is up but executions never start.** Check the app is pointed at it
(Part 2 step 11) and that `BILLRUN_ENGINE_LOOPBACK=true` is set in `.env`;
without it `lib/config.ts` rejects the plain-HTTP loopback engine URL.

**Kestra executions start but every DB task fails to authenticate.** The
`billrun_runtime` (or `rating_runtime`) password doesn't match the value in
`workflow-management/dev/.env.example` — re-run the `ALTER ROLE`s in Part 2
step 8.

**`docker compose … start workflow-engine` exits 1 with `kestra-setup is
missing dependency setup`.** Expected on this topology — use `up -d --no-deps`
instead. See "Running the stack day to day → Start".

**Kestra login 401s after changing its Basic-Auth values.** Kestra 1.3.35
validates the configured username/password at startup and silently discards the
whole credential if the username isn't an email address or the password isn't
≥8 chars with an upper, a lower and a digit. The rejection reason is recorded in
the `kestra` database's `settings` table under
`kestra.server.authentication-configuration-error`. Full detail:
`workflow-management/dev/.env.example`.

---

## Useful scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Next.js dev server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | `eslint .` |
| `npm run test` | unit **+ DB-gated** suites — ⛔ never run as-is against your dev DB; see "Tests" above |
| `npx vitest run` | DB-free unit suite (export `.env` first) |
| `npm run db:setup` | migrate + partman + full baseline seed |
| `npm run db:migrate` | apply any new forward migrations (idempotent) |
| `npm run db:seed-sample` | `_SAMPLE_*` bill-run demo scenario — run as **superuser**, see Part 3 |
| `npm run db:bootstrap-roles` | create `app_runtime`/`app_migrate` + grants |
| `npm run db:bootstrap-rating-roles` | create `rating_runtime` + grants |
| `npm run db:bootstrap-billrun-roles` | create `billrun_runtime` + grants |
| `npm run db:bootstrap-kestra-roles` | create the `kestra` DB + `kestra_engine` role |
| `npm run dev:azurite-init` | create the `kestra-internal` + `invoices` blob containers (idempotent) |
| `npm run validate:env` | check `.env.example` still satisfies the config schema |
| `docker compose ps` | what's running, and on which ports |
| `curl http://localhost:3000/api/health` | app liveness (no DB query) |

## Learn more

- Next.js docs: https://nextjs.org/docs
- Workflow-management architecture: `context/workflow-management/wfm-architecture.md`
- Module context: `context/billing-management/` and `context/rating-management/`
- DB role details: `infra/docs/db-role-verification.md`
- Bill-run flow placeholders: `workflow-management/flows/bill-run-processor/README.md`
