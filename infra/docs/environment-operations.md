# Enterprise Billing — Environment Operations Guide

Complete reference for standing the Azure environment up from scratch, connecting
to it, and managing costs by stopping services when not in use.

> **No secrets in this document.** Passwords and cert private keys are generated
> locally and never committed. Azure Key Vault stores them once deployed.

> **Known app-side gaps** that still need manual steps on a fresh deployment are
> tracked in [azure-deployment-issues.md](azure-deployment-issues.md).

---

## Contents

- [Service inventory and cost summary](#service-inventory-and-cost-summary)
- [Full setup — ordered steps (first time)](#full-setup--ordered-steps-first-time)
  - [0 — Prerequisites](#0--prerequisites)
  - [1 — Network foundation](#1--network-foundation)
  - [2 — PostgreSQL Flexible Server](#2--postgresql-flexible-server)
  - [3 — VPN Gateway](#3--vpn-gateway)
  - [4 — Connect to the VPN](#4--connect-to-the-vpn)
  - [5 — DB bootstrap (run once, on VPN)](#5--db-bootstrap-run-once-on-vpn)
    - [5a — Read admin password](#5a-read-the-admin-password-from-key-vault)
    - [5b — .env.azure.dev setup](#5b-create-envazuredev-for-local-nodejs-access)
    - [5c — Create database](#5c-create-the-application-database)
    - [5d — Migrations](#5d-run-db-migrations)
    - [5e — Role bootstrap](#5e-run-db-role-bootstrap)
    - [5f — Partman setup](#5f-set-up-pg_partman-and-pg_cron)
    - [5g — Runtime role passwords](#5g-set-runtime-role-passwords-and-store-in-key-vault)
    - [5h — Seed initial data](#5h-seed-the-initial-data)
  - [6 — Container Apps (app + Kestra)](#6--container-apps-app--kestra)
    - [6g — Entra ID SSO](#6g-enable-entra-id-sso-optional)
- [Cost management — bring down and up](#cost-management--bring-down-and-up)
  - [VPN Gateway](#vpn-gateway)
  - [PostgreSQL Flexible Server](#postgresql-flexible-server)
  - [Container Apps](#container-apps)
- [Tear down everything](#tear-down-everything)
- [Quick reference — shell variables](#quick-reference--shell-variables)

---

## Service inventory and cost summary

Pay-as-you-go **USD list prices for australiaeast** (Azure Retail Prices API,
2026-09-25), excluding tax and discounts, at the dev sizing in
`parameters/dev.bicepparam`. Running total: **≈ $1,195/mo (~$39/day)** with
everything up. Check actual spend in Cost Management; it lags by about a day.

| Service | Resource | Sizing / basis | Running | Stopped / down | How to stop |
|---|---|---|---|---|---|
| **Container App — billing app** | `ebill-dev-app` | 2 replicas × 2 vCPU / 4 GiB, always on | **~$440/mo** | ~$0 | scale to zero (see below) |
| **PostgreSQL 17 Flexible Server** | `<pg-server-name>` | GP D2ds_v5 **×2** (ZoneRedundant HA bills the standby) + 32 GB ×2 | **~$360/mo** | **~$9/mo** (storage only) | stop/start — auto-restarts after 7 days |
| **Container App — workflow engine** | `ebill-dev-workflow-engine` | 1 replica × 2 vCPU / 4 GiB, always on | **~$220/mo** | ~$0 | scale to zero |
| **VPN Gateway `VpnGw1AZ`** | `ebill-dev-vpngw` | $0.21/hr | **~$153/mo** | $0 | delete / recreate (~30–50 min back up) |
| Container Registry (Standard) | `<acr-name>` | $0.67/day | ~$20/mo | — | leave up (Basic ≈ $5 if images stay < 10 GB) |
| Gateway public IP (Standard) | `ebill-dev-vpngw-pip` | $0.005/hr | ~$4/mo | ~$4/mo | kept between VPN up/down |
| Private DNS zones ×2, Key Vault, storage account | — | per zone / per op / per GB | ~$2/mo | ~$2/mo | leave up |
| Log Analytics (PerGB2018) | `ebill-dev-logs` | ~1 MB/day ingested | ~$0 (under free 5 GB/mo) | ~$0 | leave up |
| VNets, NSGs, peering, managed identities, ACA environment (Consumption) | — | no base charge | ~$0 | ~$0 | n/a |

**How Container Apps is billed.** Per second, per replica: **vCPU ≈ $89/mo
while active** (≈ $10.50 idle) and **memory ≈ $10.50 per GiB-month**. A
replica only gets the idle vCPU rate when it uses under 0.01 cores and under
1,000 bytes/s of network. The workflow engine always counts as active (it polls
Postgres continuously), and so does the app, because health probes put it just
over the network threshold. The monthly free grant (180k vCPU-s, 360k GiB-s)
takes off about $8.

> ⚠️ **Old app revisions keep billing.** `ebill-dev-app` runs in `Multiple`
> revision mode (blue-green), so each deploy leaves the previous revision
> **active at 0% traffic with its full replica count**, which doubles the app's
> cost. After confirming the new revision works, deactivate the old one
> (reversible with `revision activate`):
>
> ```powershell
> az containerapp revision list -g $RG -n ebill-dev-app --query "[?properties.active].{name:name, traffic:properties.trafficWeight}" -o table
> az containerapp revision deactivate -g $RG -n ebill-dev-app --revision <old-revision>
> ```

**Cost-saving priority** (largest first):
1. **Scale the billing app down** when idle: `minReplicas` 0 saves ~$440 (cold
   start on first request); 1 replica instead of 2 saves ~$220.
2. **Stop Postgres** overnight and at weekends: ~$350/mo → ~$9/mo. For dev,
   `highAvailabilityMode = 'Disabled'` in `postgres.dev.bicepparam` halves the
   running cost (~$175 saved) at the price of no failover.
3. **Scale the workflow engine to zero** when not testing flows: ~$220 saved.
   Schedules and triggers don't run while it's down.
4. **Bring the VPN Gateway down** when you're not connecting: ~$153 saved.
5. Right-size the containers: each vCPU costs ~$89/mo while active, so
   1 vCPU / 2 GiB per app saves ~$165 across both.

---

## Full setup — ordered steps (first time)

### 0 — Prerequisites

```powershell
az version
az bicep version        # if missing: az bicep install
az login
az account set --subscription "<subscription-id>"

# Check required providers are registered
az provider show -n Microsoft.Network --query registrationState -o tsv
az provider show -n Microsoft.DBforPostgreSQL --query registrationState -o tsv
az provider show -n Microsoft.App --query registrationState -o tsv
az provider show -n Microsoft.KeyVault --query registrationState -o tsv
```

Set shell variables (copy once per session). Real values live in the `um30-infra`
variable group, never in this file. Once the resources exist (after steps 2 and
6b), derive the names instead of typing them:

```powershell
$RG      = "<resource-group>"
$PG_NAME = az postgres flexible-server list -g $RG --query "[0].name" -o tsv
$KV_NAME = az keyvault list -g $RG --query "[0].name" -o tsv
$PG_FQDN = "$PG_NAME.postgres.database.azure.com"
```

---

### 1 — Network foundation

Deploys hub + spoke VNets, subnets (delegated for ACA and Postgres), NSGs, and
VNet peering. Free to leave running permanently.

```powershell
# Validate
az bicep build --file infra/bicep/network/network.bicep

# Preview (no changes)
az deployment group what-if --resource-group $RG `
  --template-file infra/bicep/network/network.bicep `
  --parameters infra/bicep/network/parameters/network.dev.bicepparam

# Deploy (~1 min, idempotent)
az deployment group create --resource-group $RG --name ebill-network-dev `
  --template-file infra/bicep/network/network.bicep `
  --parameters infra/bicep/network/parameters/network.dev.bicepparam

# Verify
az network vnet list -g $RG --query "[?location=='australiaeast'].name" -o tsv
az network vnet peering list -g $RG --vnet-name ebill-dev-billing-vnet `
  --query "[].{name:name, state:peeringState}" -o table
```

Expected: two VNets in `australiaeast`, peering state `Connected`.

---

### 2 — PostgreSQL Flexible Server

Requires network (step 1) to be deployed. Creates the server, private DNS zone
(linked to both VNets), and Key Vault.

> ⏱ **~25–35 min** with `ZoneRedundant` HA (this config). Without HA ~10–15 min.
> The shell blocks until the deployment completes — it will appear to hang with no
> output for the full duration.

```powershell
# Generate a strong admin password (never stored in repo)
$env:PGADMINPASSWORD = -join ((48..57)+(65..90)+(97..122)+(33,35,37,42) | Get-Random -Count 24 | ForEach-Object {[char]$_})

# Validate
az bicep build --file infra/bicep/postgres/postgres.bicep

# Deploy
az deployment group create --resource-group $RG --name ebill-postgres-dev `
  --template-file infra/bicep/postgres/postgres.bicep `
  --parameters infra/bicep/postgres/parameters/postgres.dev.bicepparam

# Verify
az postgres flexible-server show -g $RG -n $PG_NAME `
  --query "{state:state, ha:highAvailability.mode, haState:highAvailability.state, public:network.publicNetworkAccess}" -o json

# Clear password from shell
Remove-Item Env:\PGADMINPASSWORD
```

Expected: `state: Ready`, `ha: ZoneRedundant`, `haState: Healthy`, `public: Disabled`.

Admin password and connection string are stored in Key Vault under
`postgres-admin-password` and `pg-admin-connection-string`.

---

### 3 — VPN Gateway

Required for any direct access to the private resources (psql, app debug, Kestra
UI) from a laptop. Takes **~30–45 minutes** to provision. Costs ~$154/mo while
the gateway resource exists — bring it down when you're done (see
[Cost management](#vpn-gateway)).

#### 3a. Generate P2S certificates (one-time per machine; private keys stay local)

```powershell
# Root cert
$root = New-SelfSignedCertificate -Type Custom -KeySpec Signature `
  -Subject "CN=ebill-p2s-root" -KeyExportPolicy Exportable `
  -HashAlgorithm sha256 -KeyLength 2048 `
  -CertStoreLocation "Cert:\CurrentUser\My" -KeyUsageProperty Sign -KeyUsage CertSign

# Client cert (authenticates your device)
New-SelfSignedCertificate -Type Custom -KeySpec Signature `
  -Subject "CN=ebill-p2s-client" -KeyExportPolicy Exportable `
  -HashAlgorithm sha256 -KeyLength 2048 `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -Signer $root -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.2")

# Export root public data (NOT the private key)
$rootPublic = [Convert]::ToBase64String($root.Export('Cert'))
$rootPublic | Out-File "$env:USERPROFILE\ebill-p2s-root-public.txt" -Encoding ascii
Write-Host "Saved to $env:USERPROFILE\ebill-p2s-root-public.txt"
```

> ⚠️ Never commit the `.pfx` or private keys. The `ebill-p2s-root-public.txt`
> file contains only a public key — safe to store locally, but not in the repo.

#### 3b. Deploy the gateway (passing root cert at creation time)

Azure requires the root cert to be present when certificate auth is selected.
Pass it via `--parameters` override rather than committing it to the param file.

```powershell
$rootPublic = (Get-Content "$env:USERPROFILE\ebill-p2s-root-public.txt" -Raw).Trim()

az deployment group create --resource-group $RG --name ebill-vpngw-dev `
  --template-file infra/bicep/network/vpn-gateway.bicep `
  --parameters infra/bicep/network/parameters/vpn-gateway.dev.bicepparam `
  --parameters rootCertData=$rootPublic
```

☕ ~30–45 min.

#### 3c. Enable gateway transit into the spoke

~2–3 min.

```powershell
az deployment group create --resource-group $RG --name ebill-network-dev `
  --template-file infra/bicep/network/network.bicep `
  --parameters infra/bicep/network/parameters/network.dev.bicepparam `
  --parameters hubGatewayDeployed=true
```

---

### 4 — Connect to the VPN

#### 4a. Prerequisites — one-time cert store setup

Before the Azure VPN Client can connect, two conditions must hold in your
Windows certificate stores. Run once per machine (no admin needed):

```powershell
# 1. Verify both certs exist in the personal store
Get-ChildItem Cert:\CurrentUser\My | Where-Object Subject -like "*ebill*" |
  Select-Object Subject, Thumbprint, NotAfter
# Expected: CN=ebill-p2s-root and CN=ebill-p2s-client

# 2. Trust the root cert at user level (Azure VPN Client looks in CurrentUser\Root)
$root = Get-ChildItem Cert:\CurrentUser\My | Where-Object Subject -eq "CN=ebill-p2s-root"
Export-Certificate -Cert $root -FilePath "$env:TEMP\ebill-root.cer" | Out-Null
Import-Certificate -FilePath "$env:TEMP\ebill-root.cer" -CertStoreLocation Cert:\CurrentUser\Root | Out-Null
Remove-Item "$env:TEMP\ebill-root.cer"
Write-Host "Root cert trusted at user level"
```

Windows will prompt to confirm the root cert trust — confirm it.

> **Note:** Windows built-in IKEv2 (`Add-VpnConnection -AuthenticationMethod MachineCertificate` or `Eap`) does **not** work with Azure P2S — Azure uses EAP-TLS internally which the built-in client does not negotiate correctly. Use **Azure VPN Client** only.

#### 4b. First-time: download, patch, and import the VPN profile

The auto-generated `azurevpnconfig.xml` leaves `<hash>` as nil — Azure VPN Client
cannot locate the client cert without it. The profile must be patched before import.

```powershell
# Generate profile download URL (valid for 1 hour)
az network vnet-gateway vpn-client generate --resource-group $RG `
  --name ebill-dev-vpngw --authentication-method EAPTLS -o tsv
```

Download and unzip the returned URL, then patch the XML:

```powershell
# Patch: populate <hash> with the client cert thumbprint
$clientThumbprint = (Get-ChildItem Cert:\CurrentUser\My |
  Where-Object Subject -eq "CN=ebill-p2s-client").Thumbprint.ToLower()

$profilePath = "C:\path\to\extracted\AzureVPN\azurevpnconfig.xml"   # adjust
$content = Get-Content $profilePath -Raw
$content = $content -replace '<hash i:nil="true" />', "<hash>$clientThumbprint</hash>"
Set-Content $profilePath $content

Write-Host "Patched. Thumbprint: $clientThumbprint"
```

1. Install **Azure VPN Client** from the Microsoft Store (if not already installed).
2. Open Azure VPN Client → **Import** → select the **patched** `azurevpnconfig.xml`.
3. **Save the patched file permanently** (e.g. `%USERPROFILE%\ebill-vpn\azurevpnconfig.xml`) — only the `<fqdn>` changes on future reconnects.
4. Click **Connect**.

#### 4c. Subsequent reconnects after gateway bring-up/down

Both `<fqdn>` AND `<serversecret>` change each time the gateway is recreated
(fqdn = gateway endpoint hostname; serversecret = gateway server cert hash).
Everything else in the profile (client cert issuer/hash, encryption) stays the
same. Patch both from the fresh profile zip:

```powershell
# 1. Download a fresh profile and extract the two changed fields
$url = az network vnet-gateway vpn-client generate -g $RG `
  -n ebill-dev-vpngw --authentication-method EAPTLS -o tsv
Invoke-WebRequest $url -OutFile "$env:TEMP\vp.zip"
Expand-Archive "$env:TEMP\vp.zip" -DestinationPath "$env:TEMP\vp" -Force
$freshXml  = [xml](Get-Content "$env:TEMP\vp\AzureVPN\azurevpnconfig.xml" -Raw)
$newFqdn   = $freshXml.AzVpnProfile.serverlist.ServerEntry.fqdn
$newSecret = $freshXml.AzVpnProfile.serverlist.ServerEntry.serversecret
Remove-Item "$env:TEMP\vp*" -Recurse -Force
Write-Host "New FQDN:   $newFqdn"
Write-Host "New secret: $newSecret"

# 2. Patch the saved profile (adjust path to where you saved it)
$profilePath = "$env:USERPROFILE\ebill-vpn\azurevpnconfig.xml"
$xml = Get-Content $profilePath -Raw
$xml = $xml -replace '<fqdn>[^<]*</fqdn>',           "<fqdn>$newFqdn</fqdn>"
$xml = $xml -replace '<serversecret>[^<]*</serversecret>', "<serversecret>$newSecret</serversecret>"
Set-Content $profilePath $xml
Write-Host "Profile updated — re-import in Azure VPN Client"
```

3. In Azure VPN Client → delete the old `ebill-dev-hub-vnet` profile → **Import**
   the updated `azurevpnconfig.xml` → **Connect**.

#### 4d. Verify connectivity

```powershell
# Resolve the Postgres FQDN — should return a 10.20.x.x private IP
Resolve-DnsName $PG_FQDN
```

Expected: an `A` record pointing to `10.20.0.32/28` range.

---

### 5 — DB bootstrap (run once, on VPN)

These steps run from the project root on a machine connected to the VPN.
**Run in the order shown — migrations must land before bootstrap-db-roles, because
the GRANTs reference schemas that migrations create.**

#### 5a. Read the admin password from Key Vault

```powershell
$pgPass = az keyvault secret show --vault-name $KV_NAME `
  --name postgres-admin-password --query value -o tsv
```

#### 5b. Create `.env.azure.dev` for local Node.js access

The migration and bootstrap scripts use Node.js and read config from an env file.
Create `.env.azure.dev` in the project root (this file is git-ignored):

```powershell
@"
DATABASE_URL=postgresql://ebilladmin:${pgPass}@${PG_FQDN}:5432/enterprise_billing?sslmode=require
BOOTSTRAP_DATABASE_URL=postgresql://ebilladmin:${pgPass}@${PG_FQDN}:5432/enterprise_billing?sslmode=require
BETTER_AUTH_SECRET=migration-only-placeholder-not-used-at-azure-dev-runtime
BETTER_AUTH_URL=http://localhost:3000
APP_URL=http://localhost:3000
"@ | Set-Content .env.azure.dev
```

> **Note:** `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` are required by
> `lib/config.ts` Zod validation at module-load time even for migration-only
> runs — the placeholder values satisfy the schema but are never used at runtime.

#### 5c. Create the application database

The Postgres server is deployed with only the default `postgres` system database.
Create `enterprise_billing` before running migrations. `psql` is not required —
the `postgres` npm package is available in the project:

```powershell
# Connect to the postgres system DB (not enterprise_billing, which doesn't exist yet)
node --env-file=.env.azure.dev --import tsx -e "
  import postgres from 'postgres';
  const url = process.env.BOOTSTRAP_DATABASE_URL.replace('/enterprise_billing?', '/postgres?');
  const sql = postgres(url);
  try {
    await sql\`CREATE DATABASE enterprise_billing\`;
    console.log('Created enterprise_billing.');
  } catch (e) {
    if (e.code === '42P04') console.log('Already exists.');
    else throw e;
  } finally { await sql.end(); }
"
```

#### 5d. Run DB migrations

```powershell
# --conditions=react-server is required because lib/config.ts imports "server-only"
node --conditions=react-server --env-file=.env.azure.dev --import tsx db/migrate.ts
```

Expected: `{"level":"info","msg":"Migrations applied successfully."}`

> ⚠️ **Run from the same commit as the app image.** Some migrations (e.g.
> `0006_product.sql`) have been edited in place. Drizzle skips any migration it
> has already recorded, so a database migrated from an older checkout keeps the
> old schema, and a newer app image then fails with `column ... does not exist`
> (42703). Compare the recorded hashes against the repo — every entry in
> `db/migrations/meta/_journal.json` should match `sha256` of its `.sql` file in
> `drizzle.__drizzle_migrations`.

> ⚠️ **Known issue — FK constraint name truncation (NOTICE 42622):** Many
> auto-generated FK constraint names exceed Postgres's 63-char identifier limit.
> Postgres silently truncates them and migrations still succeed — the notices are
> expected on a fresh database. See `db/migrations/README.md` §Known issues.

#### 5e. Run DB role bootstrap

Runs after migrations so the schemas exist for the GRANTs to succeed.
Four scripts must all run — each creates one or more application roles:

```powershell
# Creates app_runtime and app_migrate
node --env-file=.env.azure.dev --import tsx db/bootstrap/bootstrap-db-roles.ts

# Creates rating_runtime
node --env-file=.env.azure.dev --import tsx db/bootstrap/rating-db-roles.ts

# Creates billrun_runtime
node --env-file=.env.azure.dev --import tsx db/bootstrap/billrun-db-roles.ts

# Creates kestra_engine
node --env-file=.env.azure.dev --import tsx db/bootstrap/kestra-db-roles.ts
```

Expected: each script prints `applied successfully` or similar with a statement count.

> ⚠️ **Required follow-up — bill-run table grants.** Because 5d runs as the
> server admin (not `app_migrate`), the `ALTER DEFAULT PRIVILEGES FOR ROLE
> app_migrate` grants never fire, and `bootstrap-db-roles.sql` does not grant the
> bill-run-era `billing` tables. Without this, `app_runtime` gets `permission
> denied for table bill_run` (42501) and the Bill Run pages fail. Grant the
> parent tables only (partitions inherit); leave `customer_bill_tax_item`
> SELECT-only (`billrun_runtime` is its sole writer) and `pgledger_*` ungranted:
>
> ```powershell
> node --env-file=.env.azure.dev --import tsx -e "
>   import postgres from 'postgres';
>   const sql = postgres(process.env.BOOTSTRAP_DATABASE_URL, { max: 1 });
>   try {
>     await sql.unsafe('GRANT SELECT, INSERT, UPDATE, DELETE ON billing.bill_run, billing.bill_run_account, billing.bill_run_account_stage, billing.bill_run_distribution, billing.bill_run_invoices, billing.customer_bill TO app_runtime');
>     console.log('Granted.');
>   } finally { await sql.end(); }
> "
> ```

#### 5f. Set up pg_partman and pg_cron

Run all three partman setup scripts (audit, billing, rating schemas):

```powershell
node --env-file=.env.azure.dev --import tsx db/bootstrap/audit-partman-setup.ts
node --env-file=.env.azure.dev --import tsx db/bootstrap/billing-partman-setup.ts
node --env-file=.env.azure.dev --import tsx db/bootstrap/rating-partman-setup.ts
```

> **Azure pg_cron limitation:** On Azure Postgres Flexible Server, `CREATE
> EXTENSION pg_cron` and all `cron.*` function calls must execute against the
> `postgres` system database — running them against `enterprise_billing` fails
> with "pg_cron can only be used in the postgres database". The partman setup
> scripts handle this automatically by routing pg_cron statements to the
> `postgres` DB while keeping all other statements in `enterprise_billing`.

#### 5g. Set runtime role passwords and store in Key Vault

The KV secret names **must use hyphens** to match the names the Container App
and workflow-engine bicep modules reference directly. `psql` is not required —
passwords are stored in Key Vault first, then applied via Node.js.

> **Alphanumeric passwords only.** These passwords are embedded in `postgresql://`
> connection strings (step 6d) and in single-quoted `ALTER ROLE` SQL below.
> Characters such as `% # ! *` break URL parsing (`TypeError: Invalid URL` at app
> boot), so the generator uses `[0-9A-Za-z]` only. 32 characters from 62 symbols
> gives about 190 bits, well above the 16-character minimum.

```powershell
# Step 1: Generate passwords and store in Key Vault
$roleSecrets = @{
  'app_runtime'     = 'app-runtime-db-password'
  'app_migrate'     = 'app-migrate-db-password'
  'rating_runtime'  = 'rating-runtime-db-password'
  'billrun_runtime' = 'billrun-runtime-db-password'
  'kestra_engine'   = 'kestra-engine-db-password'
}

foreach ($role in $roleSecrets.Keys) {
  $pwd = -join (1..32 | ForEach-Object { [char](((48..57)+(65..90)+(97..122)) | Get-Random) })
  az keyvault secret set --vault-name $KV_NAME --name $roleSecrets[$role] --value $pwd --output none
  Write-Host "Stored in KV: $($roleSecrets[$role])"
}

# Step 2: Apply passwords to DB using Node.js (reads each password back from KV)
# Connects to 'postgres' system DB since ALTER ROLE is server-level
node --env-file=.env.azure.dev --import tsx -e "
  import postgres from 'postgres';
  import { execSync } from 'node:child_process';
  const url = process.env.BOOTSTRAP_DATABASE_URL.replace('/enterprise_billing?', '/postgres?');
  const sql = postgres(url);
  const kvMap = {
    app_runtime:     'app-runtime-db-password',
    app_migrate:     'app-migrate-db-password',
    rating_runtime:  'rating-runtime-db-password',
    billrun_runtime: 'billrun-runtime-db-password',
    kestra_engine:   'kestra-engine-db-password',
  };
  for (const [role, kv] of Object.entries(kvMap)) {
    const pwd = execSync(
      \`az keyvault secret show --vault-name $KV_NAME --name \${kv} --query value -o tsv\`
    ).toString().trim();
    await sql.unsafe(\`ALTER ROLE \${role} WITH PASSWORD '\${pwd}'\`);
    console.log('Set:', role);
  }
  await sql.end();
  console.log('All role passwords applied.');
"
```

#### 5h. Seed the initial data

Runs every seed in the same order as `npm run db:setup`. The admin + RBAC seeds
alone only reveal the admin pages: Products, Customers, Accounts and Billing stay
hidden (their permissions come from the domain seeds), and the accounts wizard
fails with `accounts config rows are missing`. Every seed is idempotent.

The bootstrap admin is read from the environment. The password must be at least
16 characters; set it in this session only, never in `.env.azure.dev`.

```powershell
$env:BOOTSTRAP_ADMIN_EMAIL    = "<admin-email>"
$env:BOOTSTRAP_ADMIN_PASSWORD = Read-Host "Bootstrap admin password (16+ chars)"

$seeds = @(
  "db/seeds/seed-admin.ts",
  "db/seeds/seed-rbac.ts",
  "db/seeds/product.ts",
  "db/seeds/customer.ts",
  "db/seeds/accounts/seed-accounts.ts",
  "db/seeds/ordering-inventory.ts",
  "db/seeds/billing.ts",
  "db/seeds/rating-event-catalog.ts"
)
foreach ($s in $seeds) {
  Write-Host "── $s"
  node --conditions=react-server --env-file=.env.azure.dev --import tsx $s
  if ($LASTEXITCODE -ne 0) { throw "Seed failed: $s" }
}
Remove-Item Env:\BOOTSTRAP_ADMIN_PASSWORD
```

> Keep this list in step with the `db:setup` script in `package.json`. The demo
> and sample seeds (`db:seed-demo`, `db:seed-sample`) are for local dev only.

---

### 6 — Container Apps (app + Kestra)

Deploys the ACA environment (VNet-injected, internal-only), the billing app, and
the Kestra workflow engine. The environment has no public endpoint — all access is
via the VPN tunnel (step 4). Requires VPN connection (step 3/4), Postgres
bootstrapped (step 5), and an active Azure Container Registry.

All three VNet IDs contain your subscription ID and must never be committed — pass
them as environment variables. The `postgresServerName` and
`pipelineServicePrincipalId` params follow the same pattern.

#### 6a. Set deploy-time environment variables

> **Important:** `dev.bicepparam` reads these via `readEnvironmentVariable()` at
> bicep compile time. They must be set in the **same PowerShell session** that
> runs `az deployment group create` — setting them in a prior command block won't
> work.

```powershell
$SUB_ID = az account show --query id -o tsv
$RG     = "<resource-group>"

# Required — read by dev.bicepparam
$env:POSTGRES_SERVER_NAME = $PG_NAME   # from the step 0 shell variables
$env:PIPELINE_SP_ID       = az ad signed-in-user show --query id -o tsv

# VNet IDs for the private ACA environment — contain subscription ID, NOT in repo
$env:ACA_SUBNET_ID     = "/subscriptions/$SUB_ID/resourceGroups/$RG/providers/Microsoft.Network/virtualNetworks/ebill-dev-billing-vnet/subnets/snet-billing-aca"
$env:ACA_SPOKE_VNET_ID = "/subscriptions/$SUB_ID/resourceGroups/$RG/providers/Microsoft.Network/virtualNetworks/ebill-dev-billing-vnet"
$env:ACA_HUB_VNET_ID   = "/subscriptions/$SUB_ID/resourceGroups/$RG/providers/Microsoft.Network/virtualNetworks/ebill-dev-hub-vnet"

# Entra SSO (only after step 6g). Leaving these unset on a later Phase 2
# deploy REMOVES the SSO env vars from the app and turns SSO off.
# $env:ENTRA_TENANT_ID     = az account show --query tenantId -o tsv
# $env:MICROSOFT_CLIENT_ID = az ad app list --display-name ebill-dev-app --query "[0].appId" -o tsv
```

#### 6b. Phase 1 — deploy ACR + Key Vault + ACA environment (no workloads)

Run this first to get the registry and Key Vault before pushing any images.
Env vars from step 6a must be set in the same session.

> ⏱ **~5–8 min.** Creating the VNet-injected ACA environment is the slow part.
> The shell blocks silently for the duration.

```powershell
# Leave ACA_DEFAULT_DOMAIN unset for Phase 1 (ACA env created; domain captured below)
Remove-Item Env:\ACA_DEFAULT_DOMAIN -ErrorAction SilentlyContinue

az deployment group create --resource-group $RG --name ebill-main-dev `
  --template-file infra/bicep/main.bicep `
  --parameters infra/bicep/parameters/dev.bicepparam `
  --parameters deployWorkloads=false deployWorkflowEngine=false

# Capture the ACR login server, Key Vault name, and ACA domain from outputs
$ACR_SERVER         = az deployment group show -g $RG -n ebill-main-dev `
  --query properties.outputs.acrLoginServer.value -o tsv
$KV_NAME            = az deployment group show -g $RG -n ebill-main-dev `
  --query properties.outputs.keyVaultName.value -o tsv
$ACA_DEFAULT_DOMAIN = az deployment group show -g $RG -n ebill-main-dev `
  --query properties.outputs.acaEnvironmentDefaultDomain.value -o tsv

Write-Host "ACR:    $ACR_SERVER"
Write-Host "KV:     $KV_NAME"
Write-Host "Domain: $ACA_DEFAULT_DOMAIN"
```

Expected: `ebill-dev-env` ACA environment, ACR, and Key Vault created. No
Container Apps yet.

#### 6c. Build and push container images

> ⏱ App image build: **~10–15 min** (multi-stage build; Playwright/Chromium layer
> downloads ~400 MB of browser binaries). Workflow-engine build: ~2–3 min (smaller
> base image). Each `docker push` adds another ~3–5 min over a typical connection.
> Total wall time for both: **~20–25 min**.

```powershell
# Authenticate to ACR
az acr login --name $ACR_SERVER

# App image (multi-stage; Playwright/Chromium install is the slow stage)
docker build -t "${ACR_SERVER}/enterprise-billing-app:bootstrap" .
docker push "${ACR_SERVER}/enterprise-billing-app:bootstrap"

# Workflow engine image — build context must be the workflow-engine subdirectory
# (requirements.txt and runtime/ are in that folder, not the project root)
docker build -t "${ACR_SERVER}/workflow-engine:bootstrap" `
  workflow-management/worker/workflow-engine/
docker push "${ACR_SERVER}/workflow-engine:bootstrap"
```

#### 6d. Seed Key Vault secrets

Key Vault is publicly accessible — no VPN needed for this step. Run after step 5g
so the role passwords are already stored.

```powershell
# ── App secrets ──────────────────────────────────────────────────────────────
# Passwords are URL-encoded before going into a DSN — a no-op for the
# alphanumeric passwords from step 5g, but required for any hand-set password
# containing % # ! * @ : / (otherwise the app crashes with "Invalid URL").
# The bare *-db-password secrets stay unencoded.

# Full DSN for the app runtime role (app reads DATABASE_URL from this)
$appPwd = [System.Uri]::EscapeDataString((az keyvault secret show --vault-name $KV_NAME `
  --name app-runtime-db-password --query value -o tsv))
az keyvault secret set --vault-name $KV_NAME --name pg-connection-string-app `
  --value "postgresql://app_runtime:${appPwd}@${PG_FQDN}:5432/enterprise_billing?sslmode=require" --output none

# Full DSN for the migrate job (ACA Container App Job uses this)
$migratePwd = [System.Uri]::EscapeDataString((az keyvault secret show --vault-name $KV_NAME `
  --name app-migrate-db-password --query value -o tsv))
az keyvault secret set --vault-name $KV_NAME --name pg-connection-string-migrate `
  --value "postgresql://app_migrate:${migratePwd}@${PG_FQDN}:5432/enterprise_billing?sslmode=require" --output none

# Better-Auth session secret (generate randomly; long-lived, never rotated lightly)
$authSecret = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 64 | ForEach-Object {[char]$_})
az keyvault secret set --vault-name $KV_NAME --name better-auth-secret --value $authSecret --output none

Write-Host "App secrets seeded."

# ── Workflow engine secrets ───────────────────────────────────────────────────
# These are referenced directly by name in workflow-engine-container-app.bicep
# and must already exist in KV before Phase 2 deploys the workflow engine.

# kestra-engine-db-password, rating-runtime-db-password, billrun-runtime-db-password
# are already in KV from step 5g (stored with the hyphenated names).

# Kestra admin UI password (Kestra basic auth). Kestra 1.3.35 silently rejects
# the whole Basic Auth config unless the password has upper + lower + digit
# (8+ chars) — the "Aa1" prefix guarantees all three.
$kestraPass = "Aa1" + -join (1..29 | ForEach-Object { [char](((48..57)+(65..90)+(97..122)) | Get-Random) })
az keyvault secret set --vault-name $KV_NAME --name kestra-basic-auth-password --value $kestraPass --output none

# Webhook signing key for the rating usage ingest endpoint
$webhookKey = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 40 | ForEach-Object {[char]$_})
az keyvault secret set --vault-name $KV_NAME --name rating-usage-webhook-key --value $webhookKey --output none

Write-Host "Workflow engine secrets seeded."

# ── Optional secrets ──────────────────────────────────────────────────────────
# SSO (Entra app registration). container-app.bicep references this secret ONLY
# when microsoftClientId is supplied at deploy time — skip it otherwise:
# az keyvault secret set --vault-name $KV_NAME --name microsoft-client-secret --value "<secret>"

# SFTP distribution (bm22 bill-run distribution) — skip if not configured:
# az keyvault secret set --vault-name $KV_NAME --name sftp-private-key --value "<pem>"
# az keyvault secret set --vault-name $KV_NAME --name sftp-known-hosts --value "<known_hosts>"

Write-Host "KV seeding complete."
```

#### 6e. Phase 2 — deploy Container Apps (with workloads)

Env vars from step 6a must be set in the same session. Also set
`ACA_DEFAULT_DOMAIN` (captured from Phase 1 outputs) so the private DNS zone
and VNet links are created alongside the Container Apps.

> ⏱ **~8–12 min.** Container App + Job + workflow-engine App + private DNS zone
> are created in parallel — no output until all finish. The shell blocks silently.

```powershell
# Set ACA_DEFAULT_DOMAIN to the value captured in step 6b
$env:ACA_DEFAULT_DOMAIN = $ACA_DEFAULT_DOMAIN   # captured above, or re-query:
# $env:ACA_DEFAULT_DOMAIN = az deployment group show -g $RG -n ebill-main-dev `
#   --query properties.outputs.acaEnvironmentDefaultDomain.value -o tsv

az deployment group create --resource-group $RG --name ebill-main-dev `
  --template-file infra/bicep/main.bicep `
  --parameters infra/bicep/parameters/dev.bicepparam `
  --parameters deployWorkloads=true deployWorkflowEngine=true

# App FQDN (private — only resolvable on VPN)
az deployment group show -g $RG -n ebill-main-dev `
  --query properties.outputs.appFqdn.value -o tsv
```

Access from your laptop via the VPN:
- **Billing app**: `https://ebill-dev-app.<aca-default-domain>` (HTTPS, port 443)
- **Kestra UI**: `https://ebill-dev-workflow-engine.<aca-default-domain>:8080`

The P2S VPN does not push the private DNS zone to clients, so add hosts-file
entries (elevated shell) pointing both hostnames at the environment's static IP:

```powershell
$acaIp = az containerapp env show -g $RG -n ebill-dev-env --query properties.staticIp -o tsv
"$acaIp ebill-dev-app.$ACA_DEFAULT_DOMAIN`n$acaIp ebill-dev-workflow-engine.$ACA_DEFAULT_DOMAIN" |
  Add-Content "$env:SystemRoot\System32\drivers\etc\hosts"
```

#### 6f. Verify ACA environment and apps

```powershell
$ENV_NAME = "ebill-dev-env"

# Check environment
az containerapp env show -g $RG -n $ENV_NAME `
  --query "{state:properties.provisioningState, staticIp:properties.staticIp, domain:properties.defaultDomain}" -o json

# Check apps
az containerapp list -g $RG --query "[].{name:name, state:properties.provisioningState, replicas:properties.template.scale.minReplicas}" -o table
```

#### 6g. Enable Entra ID SSO (optional)

"Sign in with Microsoft" appears only when the app has all three of
`ENTRA_TENANT_ID`, `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`.
`container-app.bicep` wires them only when `microsoftClientId` is non-empty.
There is **no just-in-time provisioning**: an Entra user can sign in only if an
**SSO** user with the same email already exists in the app. LOCAL users are
always rejected over SSO.

Requires the **Cloud Application Administrator** (or Application Administrator)
role in the tenant, or a tenant that lets users register apps.

**1. Create the app registration** — single tenant, web redirect to the app's
Better-Auth callback, with the delegated Graph scopes Better-Auth requests
(`openid profile email User.Read offline_access`):

```powershell
$domain   = az containerapp env show -g $RG -n ebill-dev-env --query properties.defaultDomain -o tsv
$redirect = "https://ebill-dev-app.$domain/api/auth/callback/microsoft"

# Microsoft Graph delegated scope IDs (stable across tenants)
@'
[{ "resourceAppId": "00000003-0000-0000-c000-000000000000", "resourceAccess": [
  { "id": "37f7f235-527c-4136-accd-4a02d197296e", "type": "Scope" },
  { "id": "14dad69e-099b-42c9-810b-d002981feec1", "type": "Scope" },
  { "id": "64a6cdd6-aab1-4aaf-94b8-3cc8405e90d0", "type": "Scope" },
  { "id": "7427e0e9-2fba-42fe-b0c0-848c9e6a8182", "type": "Scope" },
  { "id": "e1fe6dd8-ba31-4d61-89e7-88639da4683d", "type": "Scope" } ] }]
'@ | Set-Content graph-scopes.json

$appId = az ad app create --display-name "ebill-dev-app" --sign-in-audience AzureADMyOrg `
  --web-redirect-uris $redirect --required-resource-accesses "@graph-scopes.json" --query appId -o tsv
az ad sp create --id $appId --output none
Remove-Item graph-scopes.json
```

**2. Create the client secret straight into Key Vault** (never echoed). It
expires after one year; repeat this step to rotate it, then restart the app
revision.

```powershell
$s = az ad app credential reset --id $appId --append --display-name "kv:microsoft-client-secret" `
  --years 1 --query password -o tsv
az keyvault secret set --vault-name $KV_NAME --name microsoft-client-secret --value $s --output none
Remove-Variable s
```

**3. Redeploy Phase 2 with the SSO identifiers.** Run in the same shell as the
step 6a variables. Tenant and client IDs are public identifiers, but they still
come from the environment, never from committed files:

```powershell
$env:ENTRA_TENANT_ID     = az account show --query tenantId -o tsv
$env:MICROSOFT_CLIENT_ID = $appId
$env:ACA_DEFAULT_DOMAIN  = $domain

az deployment group create --resource-group $RG --name ebill-main-dev `
  --template-file infra/bicep/main.bicep `
  --parameters infra/bicep/parameters/dev.bicepparam `
  --parameters deployWorkloads=true deployWorkflowEngine=true
```

**4. Create the SSO user in the app.** Sign in as the LOCAL bootstrap admin,
go to **Administration → Users → Add user**, choose auth method **SSO**, and
enter the email the Entra token carries, with the roles it needs. Usually
that's the user's `mail`. For a guest or personal Microsoft account it's the
original address (e.g. `name@outlook.com`), not the `#EXT#` UPN. For a
cloud-only user with no mailbox, the app falls back to the UPN. Check with
`az ad user show --id <upn> --query "{mail:mail, upn:userPrincipalName}"`.

**5. Sign in with Microsoft** from the login page, over the VPN. The first
sign-in asks the user to consent to the five scopes. A tenant admin can
pre-consent for everyone under **Entra ID → App registrations → ebill-dev-app →
API permissions → Grant admin consent**. **Administration → System
Configuration** shows the redirect URI the app expects, which must match the
registration byte for byte.

> Keep the bootstrap admin LOCAL until an SSO admin has signed in
> successfully. Switching the only admin to SSO before then can lock you out.

---

## Cost management — bring down and up

### VPN Gateway

The gateway has **no pause state** — the only cost lever is delete/recreate.
The public IP and root cert file are kept so bring-up is one command (plus the
root cert upload).

#### Bring DOWN (~7–10 min total, stops $154/mo)

```powershell
$RG = "<resource-group>"

# 1. Disable gateway transit on the spoke peering first (~2–3 min, blocks)
az deployment group create --resource-group $RG --name ebill-network-dev `
  --template-file infra/bicep/network/network.bicep `
  --parameters infra/bicep/network/parameters/network.dev.bicepparam `
  --parameters hubGatewayDeployed=false

# 2. Delete the gateway (~3–5 min, blocks — this is what stops billing)
az network vnet-gateway delete -g $RG -n ebill-dev-vpngw

# 3. Confirm it's gone
az network vnet-gateway show -g $RG -n ebill-dev-vpngw -o table 2>&1
# Expected: "ResourceNotFound"
```

The public IP `ebill-dev-vpngw-pip` (~$3-4/mo) is intentionally kept for a
stable address on re-creation. To also remove it:

```powershell
az network public-ip delete -g $RG -n ebill-dev-vpngw-pip
```

#### Bring UP (~32–50 min total)

```powershell
$RG        = "<resource-group>"
$rootPublic = (Get-Content "$env:USERPROFILE\ebill-p2s-root-public.txt" -Raw).Trim()

# 1. Recreate the gateway with root cert (~30–45 min, blocks — the long step)
az deployment group create --resource-group $RG --name ebill-vpngw-dev `
  --template-file infra/bicep/network/vpn-gateway.bicep `
  --parameters infra/bicep/network/parameters/vpn-gateway.dev.bicepparam `
  --parameters rootCertData=$rootPublic

# 2. Re-enable gateway transit (~2–3 min, blocks)
az deployment group create --resource-group $RG --name ebill-network-dev `
  --template-file infra/bicep/network/network.bicep `
  --parameters infra/bicep/network/parameters/network.dev.bicepparam `
  --parameters hubGatewayDeployed=true

# 3. Re-download the VPN client profile (gateway state is recreated fresh)
az network vnet-gateway vpn-client generate --resource-group $RG `
  --name ebill-dev-vpngw --authentication-method EAPTLS
# Download and re-import the .zip into Azure VPN Client
```

---

### PostgreSQL Flexible Server

The server has a native **stop** command that halts compute billing while keeping
storage (and the standby replica slot) intact. **Auto-restarts after 7 days** —
Azure enforces this limit; plan accordingly on long breaks.

Cost when stopped: storage only (32 GB × primary + standby ≈ **$9/mo**).
Cost when running: GP D2ds_v5 primary + ZoneRedundant standby (≈ **$360/mo**).

#### Stop (save ~$350/mo)

```powershell
$RG      = "<resource-group>"
$PG_NAME = "<pg-server-name>"

az postgres flexible-server stop -g $RG -n $PG_NAME

# Check state (transitions Stopping → Stopped)
az postgres flexible-server show -g $RG -n $PG_NAME `
  --query "{state:state, ha:highAvailability.mode}" -o json
```

> ⚠️ **7-day auto-restart:** Azure automatically restarts a stopped Flexible
> Server after 7 days. If you need it stopped longer, re-stop it before the
> 7-day mark or accept the restart. You will be charged for the period it runs.

#### Start

```powershell
az postgres flexible-server start -g $RG -n $PG_NAME

# Wait for Ready state (1-2 min typically)
az postgres flexible-server show -g $RG -n $PG_NAME `
  --query "{state:state, haState:highAvailability.state}" -o json
```

Expected: `state: Ready`, `haState: Healthy`.

---

### Container Apps

Consumption-plan apps bill per second for every **running replica**, whether
or not it serves traffic. `minReplicas ≥ 1` means it bills 24/7 (see the cost
table: ~$440/mo app, ~$220/mo engine at dev sizing). Stop the apps to bring
that to $0.

```powershell
$RG  = "<resource-group>"
$APP = "ebill-dev-app"
$WFE = "ebill-dev-workflow-engine"
```

#### Stop / Start (recommended — $0 while stopped, config and revisions kept)

`az containerapp stop/start` is missing from some `containerapp` extension
versions (`'stop' is misspelled or not recognized`), so call the ARM actions
directly:

```powershell
$SUB = az account show --query id -o tsv
function Invoke-AcaAction($app, $action) {
  az rest --method post -o none --url "https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.App/containerApps/$app/${action}?api-version=2024-03-01"
}

# Stop (removes all replicas; stop the apps before stopping Postgres)
Invoke-AcaAction $APP stop
Invoke-AcaAction $WFE stop

# Start (restores the previous scale settings; start Postgres first)
Invoke-AcaAction $WFE start
Invoke-AcaAction $APP start

# Check: runningStatus should read Stopped / Running
az containerapp list -g $RG --query "[].{name:name, status:properties.runningStatus}" -o table
```

#### Scale to zero instead (app wakes on the first request)

`--max-replicas` must stay ≥ 1. With `--min-replicas 0` the app scales out on
the first HTTP request (cold start), and in idle periods it bills only while a
replica is up. The engine has no ingress, so at 0 it stays down until it's
restored.

```powershell
az containerapp update -n $APP -g $RG --min-replicas 0
az containerapp update -n $WFE -g $RG --min-replicas 0

# Restore to the dev.bicepparam values (a Phase 2 redeploy also restores them)
az containerapp update -n $APP -g $RG --min-replicas 2 --max-replicas 3
az containerapp update -n $WFE -g $RG --min-replicas 1 --max-replicas 1
```

> **Note:** A Consumption-only ACA environment (`ebill-dev-env`) has no base
> charge, so leave it up. Only running replicas cost money.

#### Bring everything back up (order matters)

1. **Postgres** `start`, then wait for `state: Ready`.
2. **VPN Gateway** bring-up (only if you need to connect; ~30–50 min).
3. **Container Apps** `start` (engine and app). They need the database at boot.

---

## Tear down everything

Removes all the resources created by the bicep templates. The pre-existing
`dnb_network` VNet and `NSG_billing` NSG (not created by these templates) are
**not** touched.

```powershell
$RG      = "<resource-group>"
$PG_NAME = "<pg-server-name>"
$KV_NAME = "<kv-name>"

# 1. Delete Container Apps (if deployed)
az containerapp delete -n ebill-dev-app -g $RG --yes 2>$null
az containerapp delete -n ebill-dev-workflow-engine -g $RG --yes 2>$null
az containerapp env delete -n ebill-dev-env -g $RG --yes 2>$null

# 2. Delete the ACA private DNS zone (created by main.bicep when VNet-integrated)
#    Zone name matches the ACA environment's defaultDomain — check it first:
#    az network private-dns zone list -g $RG -o table
az network private-dns zone delete -g $RG --yes `
  -n "$(az containerapp env show -g $RG -n ebill-dev-env --query properties.defaultDomain -o tsv 2>$null)" 2>$null

# 3. Stop and delete Postgres
az postgres flexible-server delete -g $RG -n $PG_NAME --yes

# 4. Delete the VPN Gateway (if up)
az network vnet-gateway delete -g $RG -n ebill-dev-vpngw 2>$null
az network public-ip delete -g $RG -n ebill-dev-vpngw-pip 2>$null

# 5. Delete the network (VNets, NSGs, peering)
az network vnet delete -g $RG -n ebill-dev-billing-vnet
az network vnet delete -g $RG -n ebill-dev-hub-vnet
az network nsg delete -g $RG -n ebill-dev-aca-nsg
az network nsg delete -g $RG -n ebill-dev-postgres-nsg

# 6. Delete the Postgres private DNS zone
az network private-dns zone delete -g $RG `
  -n "ebill-dev.private.postgres.database.azure.com" --yes

# 7. Purge the Key Vault (soft-delete means it lingers 90 days otherwise)
az keyvault delete -g $RG -n $KV_NAME
az keyvault purge -n $KV_NAME --location australiaeast

# 8. Verify only the pre-existing resources remain
az resource list -g $RG --query "[].{name:name, type:type}" -o table
# Expected: only dnb_network + NSG_billing
```

---

## Quick reference — shell variables

Copy this block at the start of any ops session:

```powershell
$RG        = "<resource-group>"
$LOC       = "australiaeast"
$PG_NAME   = "<pg-server-name>"
$PG_FQDN   = "<pg-server-name>.postgres.database.azure.com"
$KV_NAME   = "<kv-name>"     # set from deployment output
$GW_NAME   = "ebill-dev-vpngw"
$GW_PIP    = "ebill-dev-vpngw-pip"
$HUB_VNET  = "ebill-dev-hub-vnet"
$SPK_VNET  = "ebill-dev-billing-vnet"
$ACA_ENV   = "ebill-dev-env"
$APP       = "ebill-dev-app"
$WFE       = "ebill-dev-workflow-engine"
```
