// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE Azure Database for PostgreSQL — Flexible Server (dev tier).
//
// Greenfield CREATE (not the repo's existing `modules/postgres.bicep`, which
// only tweaks settings on a pre-existing server). This one stands the server up
// with VNet integration (private access), so it has NO public endpoint and is
// reachable only from the Billing spoke and — over the VPN — from the hub.
//
// Plugs into the network foundation (infra/bicep/network):
//   • delegated subnet  snet-billing-postgres  (Microsoft.DBforPostgreSQL/flexibleServers)
//   • private DNS zone   ebill-<env>.private.postgres.database.azure.com
//                        linked to BOTH the spoke (app/ACA) and hub (VPN clients),
//                        because DNS resolution and peering are independent.
//
// Also creates the platform Key Vault and stores the admin credential there
// (never in the repo or the shell history beyond deploy time). Later modules
// (ACA app + Kestra) reference this same vault.
//
// NET-NEW vs the architecture docs (flagged, like the VPN): the private DNS zone
// and private-only access. Prod equivalent differs — see README "Prod deltas".
//
// Dev tier defaults: Burstable B1ms, 32 GB, HA off, 7-day backups. Override per
// environment for staging/prod (General Purpose + zone-redundant HA).
// ─────────────────────────────────────────────────────────────────────────────

targetScope = 'resourceGroup'

@allowed(['dev', 'staging', 'prod'])
param environmentName string

@description('Must match the VNet region (the server must be in the same region as its delegated subnet).')
param location string = resourceGroup().location

// ── Network wiring (from infra/bicep/network) ────────────────────────────────
@description('Name of the Billing spoke VNet that owns the delegated Postgres subnet.')
param spokeVnetName string = 'ebill-${environmentName}-billing-vnet'

@description('Name of the hub VNet (for the VPN-client-side DNS zone link).')
param hubVnetName string = 'ebill-${environmentName}-hub-vnet'

@description('Name of the delegated subnet the server injects into.')
param postgresSubnetName string = 'snet-billing-postgres'

// ── Server identity + sizing ─────────────────────────────────────────────────
@description('Admin login. Cannot be a reserved name (azure_superuser, admin, root, ...) or start with "pg_".')
param administratorLogin string = 'ebilladmin'

@secure()
@description('Admin password. REQUIRED at deploy time (no default) — pass via `--parameters administratorLoginPassword=...`. Never committed. Stored into Key Vault by this template.')
param administratorLoginPassword string

@description('PostgreSQL major version. Pinned to 17 (architecture): the partman bootstrap SQL needs pg_partman 5.x, which ships on PGDG PG-17.')
@allowed(['17'])
param postgresVersion string = '17'

@description('Compute SKU. Dev default Burstable B1ms; staging/prod move to General Purpose (e.g. Standard_D2ds_v5).')
param skuName string = 'Standard_B1ms'

@allowed(['Burstable', 'GeneralPurpose', 'MemoryOptimized'])
param skuTier string = 'Burstable'

@description('Storage size in GB. Minimum 32.')
param storageSizeGB int = 32

@description('Backup retention in days (7-35).')
@minValue(7)
@maxValue(35)
param backupRetentionDays int = 7

@allowed(['Disabled', 'ZoneRedundant', 'SameZone'])
@description('High availability. NOTE: HA (ZoneRedundant or SameZone) is NOT supported on the Burstable tier — it requires GeneralPurpose/MemoryOptimized. ZoneRedundant places the standby in another availability zone (~2x compute + storage cost).')
param highAvailabilityMode string = 'Disabled'

// ── Server configurations (um27 — audit/billing/rating partman + cron) ───────
@description('azure.extensions allow-list. Must include PG_PARTMAN, PG_CRON, PGCRYPTO. Full-replacement value.')
param allowedExtensions string = 'PG_PARTMAN,PG_CRON,PGCRYPTO'

@description('shared_preload_libraries. Must include pg_cron. Applying it triggers a one-time server restart. Full-replacement value.')
param sharedPreloadLibraries string = 'pg_cron'

@description('Server display timezone (IANA). Storage stays UTC; kept UTC so audit_log range-partition boundaries stay aligned.')
param serverTimezone string = 'UTC'

// ── Platform Key Vault ───────────────────────────────────────────────────────
// Same name formula the parked app stack (modules/main.bicep) uses, so when the
// ACA app module lands it references THIS vault as existing rather than making a
// second one.
@description('Platform Key Vault name (<=24 chars, globally unique).')
param keyVaultName string = take('ebill-${environmentName}-kv-${uniqueString(resourceGroup().id)}', 24)

var serverName = 'ebill-${environmentName}-pg-${uniqueString(resourceGroup().id)}'
var privateDnsZoneName = 'ebill-${environmentName}.private.postgres.database.azure.com'

// Existing VNets (created by infra/bicep/network) — referenced for their IDs.
resource spokeVnet 'Microsoft.Network/virtualNetworks@2023-09-01' existing = {
  name: spokeVnetName
}

resource hubVnet 'Microsoft.Network/virtualNetworks@2023-09-01' existing = {
  name: hubVnetName
}

// ── Private DNS zone + VNet links ────────────────────────────────────────────
resource privateDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: privateDnsZoneName
  location: 'global'
}

// Spoke link — lets the app / ACA resolve the server's FQDN to its private IP.
resource spokeZoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: privateDnsZone
  name: 'link-to-spoke'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: spokeVnet.id
    }
  }
}

// Hub link — lets P2S VPN clients (which terminate in the hub) resolve the FQDN.
// Peering does NOT propagate private DNS; the link is what enables resolution.
resource hubZoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: privateDnsZone
  name: 'link-to-hub'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: hubVnet.id
    }
  }
}

// ── Flexible Server (private) ────────────────────────────────────────────────
resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2023-06-01-preview' = {
  name: serverName
  location: location
  sku: {
    name: skuName
    tier: skuTier
  }
  properties: {
    version: postgresVersion
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorLoginPassword
    createMode: 'Default'
    storage: {
      storageSizeGB: storageSizeGB
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: backupRetentionDays
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: highAvailabilityMode
    }
    // Private access (VNet integration). Setting delegatedSubnetResourceId makes
    // the server private (no public endpoint); privateDnsZoneArmResourceId is
    // mandatory for private-access creation. Both are immutable after create.
    network: {
      delegatedSubnetResourceId: '${spokeVnet.id}/subnets/${postgresSubnetName}'
      privateDnsZoneArmResourceId: privateDnsZone.id
    }
  }
  // The zone must be linked before the server registers its record.
  dependsOn: [
    spokeZoneLink
    hubZoneLink
  ]
}

// ── Server configurations ────────────────────────────────────────────────────
// azure.extensions is dynamic (no restart); it gates which extensions CREATE
// EXTENSION may install.
resource azureExtensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-06-01-preview' = {
  parent: postgresServer
  name: 'azure.extensions'
  properties: {
    value: allowedExtensions
    source: 'user-override'
  }
}

// shared_preload_libraries is STATIC — applying it restarts the server once.
// Serialized after azure.extensions to avoid concurrent config writes.
resource sharedPreload 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-06-01-preview' = {
  parent: postgresServer
  name: 'shared_preload_libraries'
  properties: {
    value: sharedPreloadLibraries
    source: 'user-override'
  }
  dependsOn: [
    azureExtensions
  ]
}

resource timezoneConfig 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-06-01-preview' = {
  parent: postgresServer
  name: 'timezone'
  properties: {
    value: serverTimezone
    source: 'user-override'
  }
  dependsOn: [
    sharedPreload
  ]
}

// ── Platform Key Vault + admin credential secrets ────────────────────────────
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    // No public data-plane endpoint — this vault holds the Postgres admin
    // password + a plaintext superuser connection string. The rest of this
    // template goes to real lengths (VNet injection, private DNS, hub/spoke)
    // to keep the Postgres admin path private; leaving the vault that holds
    // those same credentials open to the internet (RBAC as the only gate,
    // no network layer) would undercut that. Secret reads now require VPN /
    // VNet access, same as the server itself.
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
    }
  }
}

resource adminPasswordSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'postgres-admin-password'
  properties: {
    value: administratorLoginPassword
  }
}

// Convenience secret for the one-time bootstrap steps (roles, partman) that run
// AS the admin. libpq URI form; sslmode=require because the server enforces TLS.
resource adminConnStringSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'pg-admin-connection-string'
  properties: {
    value: 'postgresql://${administratorLogin}:${administratorLoginPassword}@${postgresServer.properties.fullyQualifiedDomainName}:5432/postgres?sslmode=require'
  }
}

// ── Outputs ──────────────────────────────────────────────────────────────────
output postgresServerName string = postgresServer.name
output postgresServerFqdn string = postgresServer.properties.fullyQualifiedDomainName
output privateDnsZoneName string = privateDnsZone.name
output delegatedSubnetResourceId string = '${spokeVnet.id}/subnets/${postgresSubnetName}'
output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
