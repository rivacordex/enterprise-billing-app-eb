# Enterprise Billing — Private PostgreSQL Flexible Server

Manual setup guide for the **private-access** Azure Database for PostgreSQL
Flexible Server that backs the app + Kestra.

> **No secrets in this document.** The admin password is generated locally and
> passed at deploy time; it is never written here or committed. This template
> stores it in Key Vault for you.

**Prerequisite:** the network foundation (`infra/bicep/network`) must already be
deployed — this server injects into its `snet-billing-postgres` subnet and links
its private DNS zone to both VNets.

---

## What this deploys

| Resource | Detail |
|---|---|
| **Flexible Server** `ebill-dev-pg-<hash>` | PostgreSQL **17**, **Burstable B1ms** (1 vCore/2 GB), 32 GB, **HA off**, 7-day backups |
| **Private access** | Injected into `snet-billing-postgres` — **no public endpoint** |
| **Private DNS zone** `ebill-dev.private.postgres.database.azure.com` | Linked to the **spoke** (app/ACA) and **hub** (VPN clients) |
| **Server configs** | `azure.extensions` = PG_PARTMAN,PG_CRON,PGCRYPTO · `shared_preload_libraries` = pg_cron (triggers a one-time restart) · `timezone` = UTC |
| **Key Vault** `ebill-dev-kv-<hash>` | Stores `postgres-admin-password` + `pg-admin-connection-string` |

**Reachability:** because there's no public endpoint, you can only connect from
inside the Billing spoke (the app/Kestra) or **over the VPN** (once the gateway
is up and the hub DNS link resolves the FQDN). You cannot `psql` to it from a
laptop that isn't on the VPN.

---

## Deploy

Set your target and **generate a strong admin password locally** (not stored in
the repo — the template puts it into Key Vault):

```powershell
$RG  = "<resource-group>"

# Generate a strong password and expose it as the env var the .bicepparam reads.
# (Any 16+ char strong secret works; it never touches the repo.)
$env:PGADMINPASSWORD = -join ((48..57)+(65..90)+(97..122)+(33,35,37,42) | Get-Random -Count 24 | ForEach-Object {[char]$_})

# Validate first (no cost)
az bicep build --file infra/bicep/postgres/postgres.bicep

# Deploy (~5-10 min; the shared_preload_libraries change adds a one-time restart).
# The password is pulled from $env:PGADMINPASSWORD via readEnvironmentVariable().
az deployment group create --resource-group $RG --name ebill-postgres-dev `
  --template-file infra/bicep/postgres/postgres.bicep `
  --parameters infra/bicep/postgres/parameters/postgres.dev.bicepparam
```

> Keep the password for the one-time bootstrap steps below, or read it back from
> Key Vault later (`az keyvault secret show`, which needs the **Key Vault Secrets
> User** role on an RBAC vault). The vault has no public data-plane endpoint
> (`publicNetworkAccess: 'Disabled'`), so that read must happen from inside the
> VNet or over the VPN — same reachability constraint as the server itself.
> Clear it from your shell when done: `Remove-Item Env:\PGADMINPASSWORD`.

### Verify

```powershell
az postgres flexible-server show -g $RG -n <serverName> `
  --query "{name:name, ver:version, state:state, public:network.publicNetworkAccess, subnet:network.delegatedSubnetResourceId, dns:network.privateDnsZoneArmResourceId}" -o json
```

`publicNetworkAccess` should be `Disabled`. Grab the FQDN from the deployment
outputs (`postgresServerFqdn`).

---

## After deploy — one-time bootstrap (run from ON the VPN / inside the VNet)

These are **not** part of this template (they run SQL as the admin, which Bicep
can't express) — see the repo's existing docs:

1. **Create the least-privilege roles** — `db/bootstrap/bootstrap-db-roles.sql`
   (`app_runtime`, `app_migrate`, `rating_runtime`, `billrun_runtime`,
   `kestra_engine`). See `infra/docs/db-role-verification.md`.
2. **Partman/cron objects** — `npm run db:setup-partman` under an elevated
   connection. See `infra/docs/audit-partman-setup.md`. (The `shared_preload_libraries`
   restart this template applied is the prerequisite for pg_cron.)
3. Set each runtime role's password (`ALTER ROLE ... WITH PASSWORD`) and store it
   in Key Vault (`rating-runtime-db-password`, `billrun-runtime-db-password`,
   `kestra-engine-db-password`, plus the app/migrate connection strings) — the
   secrets the app + engine modules will reference.

---

## Cost note

Deployed **HA ZoneRedundant, General Purpose D2ds_v5** ≈ **~$350-400/mo** (2 vCores/8 GB + 32 GB storage + standby replica).

`southeastasia` was evaluated but `ZoneRedundantHa` is **Disabled** there. `australiaeast` is the closest HA-capable region for SEA/KL and was confirmed open on this subscription.

| Setting | Value |
|---|---|
| Region | `australiaeast` |
| Compute | General Purpose `Standard_D2ds_v5` |
| HA | `ZoneRedundant` |
| Backups | 7 days, local |

---

## Notes

- **Net-new infra flag:** the private DNS zone + private-only access are net-new
  vs the architecture docs (which specify Flexible Server + Key Vault + Managed
  Identity but not private networking). Flagged like the VPN.
- **Immutable choices:** private access, the delegated subnet, and the private
  DNS zone are set **at creation only** — they cannot be added or changed later
  (you'd recreate the server). HA and compute size can change in place.
- The Key Vault uses the **same name** the parked app stack (`modules/main.bicep`)
  would generate, so the ACA app module can reference it as existing instead of
  creating a second vault.
