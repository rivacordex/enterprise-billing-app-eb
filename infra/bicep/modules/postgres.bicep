// um30-spec §"3. Infrastructure as Code (Bicep)" — modules/postgres.bicep.
// References the existing Flexible Server (provisioned in um02, outside
// this unit's scope) rather than creating one. The `app_runtime`/
// `app_migrate` role bootstrap is a one-time documented step run by
// db/migrations/0005_bootstrap_db_roles.sql under a superuser/owner
// connection — see infra/docs/db-role-verification.md — not something
// Bicep can express as idempotent ARM state, so it is not run from here.
param postgresServerName string
param location string

resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2023-06-01-preview' existing = {
  name: postgresServerName
}

output postgresServerFqdn string = postgresServer.properties.fullyQualifiedDomainName
output postgresServerLocation string = location
