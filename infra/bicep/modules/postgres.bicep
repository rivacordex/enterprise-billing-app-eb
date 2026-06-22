// um30-spec §"3. Infrastructure as Code (Bicep)" — modules/postgres.bicep.
// References the existing Flexible Server (provisioned in um02, outside
// this unit's scope) rather than creating one. The `app_runtime`/
// `app_migrate` role bootstrap is a one-time documented step run by
// db/bootstrap/bootstrap-db-roles.sql (via `npm run db:bootstrap-roles`)
// under a superuser/owner connection during provisioning, before the
// automated app_migrate-run migrate stage ever runs — see
// infra/docs/db-role-verification.md — not something Bicep can express as
// idempotent ARM state, so it is not run from here.
param postgresServerName string

resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2023-06-01-preview' existing = {
  name: postgresServerName
}

output postgresServerFqdn string = postgresServer.properties.fullyQualifiedDomainName
output postgresServerLocation string = postgresServer.location
