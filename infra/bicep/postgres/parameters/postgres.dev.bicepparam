using '../postgres.bicep'

param environmentName = 'dev'
param location = 'australiaeast'

// Network wiring — must match the deployed infra/bicep/network resources.
param spokeVnetName = 'ebill-dev-billing-vnet'
param hubVnetName = 'ebill-dev-hub-vnet'
param postgresSubnetName = 'snet-billing-postgres'

// Server identity + sizing.
// General Purpose D2ds_v5 with ZoneRedundant HA (australiaeast confirmed HA-capable).
// southeastasia was considered but ZoneRedundantHa is Disabled there.
param administratorLogin = 'ebilladmin'
param postgresVersion = '17'
param skuName = 'Standard_D2ds_v5'
param skuTier = 'GeneralPurpose'
param storageSizeGB = 32
param backupRetentionDays = 7
param highAvailabilityMode = 'ZoneRedundant'

// um27 partman/cron server settings.
param allowedExtensions = 'PG_PARTMAN,PG_CRON,PGCRYPTO'
param sharedPreloadLibraries = 'pg_cron'
param serverTimezone = 'UTC'

// Admin password is read from an ENVIRONMENT VARIABLE at deploy time, so the
// secret never lives in this file. Set $env:PGADMINPASSWORD before deploying
// (fail-closed: the deploy errors if it is unset). See README.md "Deploy".
param administratorLoginPassword = readEnvironmentVariable('PGADMINPASSWORD')
