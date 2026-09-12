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

// This solution is PINNED to PostgreSQL major 17. The audit/billing/rating
// partman bootstrap SQL (db/bootstrap/*-partman-setup.sql) uses pg_partman 5.x's
// named-parameter create_parent() signature (PGDG's PG-17 build); a PG-16 server
// gets partman 4.x with the incompatible 'native' p_type signature. Local Docker
// (infra/docker/postgres) is postgres:17-bookworm, so local mirrors prod.
//
// ENFORCEMENT is NOT in this module: it references the server as `existing`
// (provisioned out of band — um02 / the um30-infra variable group) and can
// neither set nor block on the server's major. The HARD stop already lives
// where the coupling actually bites: the pg_partman-version preflight at the top
// of each db/bootstrap/*-partman-setup.sql, which RAISES and fails
// `db:setup-partman` on a pre-v5 server. The `serverMajorMatchesPin` output
// below is only an EARLIER, clearer drift signal for whoever runs the
// out-of-band `az deployment` — not a gate.
var pinnedPostgresMajor = '17'

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

// Early DRIFT SIGNAL for the PG-17 pin (see the pinnedPostgresMajor comment):
// surface the live server major and whether it matches. This is NOT an
// enforcement gate — the module can't change an existing server's major and is
// applied out of band; the real hard stop is the pg_partman v5 preflight in
// db/bootstrap/*-partman-setup.sql. A `false` here is an early warning to fix
// the provisioned major before running db:setup-partman against it.
output detectedPostgresVersion string = postgresServer.properties.version
output serverMajorMatchesPin bool = startsWith(
  postgresServer.properties.version,
  pinnedPostgresMajor
)
