// um30-spec §"3. Infrastructure as Code (Bicep)" — modules/postgres.bicep.
// References the existing Flexible Server (provisioned in um02, outside
// this unit's scope) rather than creating one. The `app_runtime`/
// `app_migrate` role bootstrap is a one-time documented step run by
// db/bootstrap/bootstrap-db-roles.sql (via `npm run db:bootstrap-roles`)
// under a superuser/owner connection during provisioning, before the
// automated app_migrate-run migrate stage ever runs — see
// infra/docs/db-role-verification.md — not something Bicep can express as
// idempotent ARM state, so it is not run from here.
//
// um27-spec §3.5 — audit-log partitioning needs two server-level settings:
//   1. `azure.extensions` allow-list must permit PG_PARTMAN, PG_CRON, and
//      PGCRYPTO (pgcrypto provides gen_random_bytes() for core.generate_ulid()).
//   2. `shared_preload_libraries` must include pg_cron (the scheduler). This
//      requires a ONE-TIME server restart (accepted at sign-off). pg_partman_bgw
//      is intentionally NOT added — maintenance is driven by pg_cron's
//      run_maintenance_proc() call, not the background worker.
// The actual partman/cron objects (create_parent, retention, the daily cron
// job) are provisioned post-restart by `npm run db:setup-partman` under an
// elevated connection — see infra/docs/audit-partman-setup.md. Those allow-list
// values are full-replacement settings; the defaults below must therefore carry
// every extension/library the server already relies on, not only the new ones.
param postgresServerName string

// PINNED to PostgreSQL major 17 (not "≥16"). The audit/billing/rating partman
// bootstrap SQL (db/bootstrap/*-partman-setup.sql) uses pg_partman 5.x's
// named-parameter create_parent() signature, which PGDG ships for PG 17; a
// PG-16 server would get partman 4.x with the incompatible 'native' p_type
// signature, so the same bootstrap that works on local Docker (postgres:17-
// bookworm) would fail. The Flexible Server itself is provisioned out of band
// (um02 / the um30-infra variable group) and must be CREATED at this major;
// this module references it as `existing` and cannot change an in-place major,
// so `serverMajorMatchesPin` below is a deploy-time DRIFT GUARD (surfaced as an
// output) rather than a setter — a mismatch means the provisioning targeted the
// wrong major and must be fixed at the source, before configuring partman on it.
@description('Pinned PostgreSQL major version. Only 17 is permitted (pg_partman 5.x coupling — see comment).')
@allowed(['17'])
param postgresVersion string = '17'

// Required (no default): azure.extensions and shared_preload_libraries are
// full-replacement settings, so a silent module default would overwrite
// whatever the server already has. The caller must pass the complete value.
@description('Comma-separated azure.extensions allow-list. Must include PG_PARTMAN, PG_CRON, PGCRYPTO (um27) plus any extension the server already allows.')
param allowedExtensions string

@description('Comma-separated shared_preload_libraries. Must include pg_cron (um27) plus any library already preloaded. Changing this requires a one-time server restart.')
param sharedPreloadLibraries string

@description('Server display timezone (IANA name) for the `timezone` GUC. Controls how timestamptz values and now() RENDER, not how they are stored (storage stays UTC). Kept at UTC by default so audit_log range-partition boundaries (um27, computed against the session/server zone) stay aligned; override per-role/session for local display instead of changing this in place after partitions exist.')
param serverTimezone string = 'UTC'

resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2023-06-01-preview' existing = {
  name: postgresServerName
}

// azure.extensions is a dynamic (no-restart) server parameter; it gates which
// extensions a CREATE EXTENSION may install.
resource azureExtensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-06-01-preview' = {
  parent: postgresServer
  name: 'azure.extensions'
  properties: {
    value: allowedExtensions
    source: 'user-override'
  }
}

// shared_preload_libraries is a STATIC server parameter — applying this triggers
// the one-time restart called out at um27 sign-off.
resource sharedPreload 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-06-01-preview' = {
  parent: postgresServer
  name: 'shared_preload_libraries'
  properties: {
    value: sharedPreloadLibraries
    source: 'user-override'
  }
}

// timezone is a dynamic (no-restart) server parameter; it sets the default
// display zone for new sessions. Changing it does NOT rewrite stored data.
resource timezoneConfig 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-06-01-preview' = {
  parent: postgresServer
  name: 'timezone'
  properties: {
    value: serverTimezone
    source: 'user-override'
  }
}

output postgresServerFqdn string = postgresServer.properties.fullyQualifiedDomainName
output postgresServerLocation string = postgresServer.location

// Deploy-time DRIFT GUARD for the PG-17 pin (see the postgresVersion comment):
// surface the live server major, and whether it matches the pin. This module
// references the server as `existing` and cannot change an in-place major, so a
// `false` here means the out-of-band provisioning (um02 / um30-infra) targeted
// the wrong version and must be corrected before partman is configured on it.
output detectedPostgresVersion string = postgresServer.properties.version
output serverMajorMatchesPin bool = startsWith(
  postgresServer.properties.version,
  postgresVersion
)
