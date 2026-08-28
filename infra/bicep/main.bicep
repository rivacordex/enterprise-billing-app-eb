// um30-spec §"3. Infrastructure as Code (Bicep)" — main.bicep. Orchestrates
// all modules, parameterized per environment via parameters/*.bicepparam.
@allowed(['dev', 'staging', 'prod'])
param environmentName string
param location string = resourceGroup().location

// Name of the existing Postgres Flexible Server this environment targets. A real
// per-environment Azure resource identifier — supplied at DEPLOY TIME from the
// `um30-infra` variable group (`--parameters postgresServerName=$(POSTGRES_SERVER_NAME)`),
// NOT hardcoded in the committed `*.bicepparam`, so concrete server names stay out
// of source control (mirrors the SSO-ID handling below). Required — no default, so
// a deploy that forgets to supply it fails fast rather than targeting the wrong server.
param postgresServerName string

// Full-replacement server settings (um27) — passed explicitly to the postgres
// module, which requires them so a hidden default can't clobber the server's
// existing config. Override per-environment to carry any extension/library the
// server already relies on. Changing sharedPreloadLibraries needs a one-time
// server restart.
param allowedExtensions string = 'PG_PARTMAN,PG_CRON,PGCRYPTO'
param sharedPreloadLibraries string = 'pg_cron'

// Object (principal) ID of the Azure DevOps deployment service principal, granted
// Key Vault Secrets Officer (key-vault module) so the pipeline can seed secrets. A
// real per-environment identity — supplied at DEPLOY TIME from the `um30-infra`
// variable group (`--parameters pipelineServicePrincipalId=$(PIPELINE_SP_ID)`), NOT
// committed to `*.bicepparam`, so the concrete object ID stays out of source control.
param pipelineServicePrincipalId string
param minReplicas int = 2
param maxReplicas int = 5

// Non-secret Microsoft SSO identifiers (tenant + client ID), passed straight
// through to the container-app module. Supplied at deploy time from the
// `um30-infra` variable group (e.g. `az deployment group create --parameters
// entraTenantId=$(ENTRA_TENANT_ID) microsoftClientId=$(MICROSOFT_CLIENT_ID)`),
// NOT hardcoded in the committed `*.bicepparam` — the concrete IDs stay out of
// source control. Empty (default) disables SSO env wiring for the environment;
// the client SECRET is always a Key Vault reference, never a parameter.
param entraTenantId string = ''
param microsoftClientId string = ''

// Business timezone (IANA name) surfaced to the app as APP_TIMEZONE (um29-spec):
// governs how every admin datetime is displayed and how local day boundaries
// (e.g. the Audit Log date filter) resolve; storage stays UTC. Non-secret and
// environment-specific, so — unlike entraTenantId/microsoftClientId above — it
// lives in the committed `*.bicepparam`. @allowed mirrors lib/locale.ts
// SUPPORTED_TIMEZONES so an unsupported value fails at deploy time (the app also
// fails fast at boot). Defaults to UTC (behavior-preserving).
@allowed([
  'Asia/Kuala_Lumpur'
  'Asia/Singapore'
  'Asia/Kolkata'
  'Africa/Johannesburg'
  'Asia/Dubai'
  'America/New_York'
  'America/Los_Angeles'
  'Australia/Sydney'
  'UTC'
])
param appTimezone string = 'UTC'

@description('Gates the Container App + migrate Job (phase-2 workloads). Deploy with false first so the Key Vault exists and its secret references can be populated + the ACR image pushed, then true.')
param deployWorkloads bool = true

// rm04-spec D0 — "do not build the rest of this unit until the process-
// runner spike passes." The rating-engine module (storage + Container App)
// is authored and ready, but the spike proving a custom Kestra image on
// ACA's process runner actually works has NOT been run (no Azure access in
// the session that authored this). Defaults to false so this module cannot
// be deployed by accident; flip to true only after the spike (Open item 7)
// passes and its result is recorded in ratemgmt-progress-tracker.md.
@description('Gates the rating-engine Container App + storage (rm04). Leave false until the D0 process-runner spike has passed on a real environment.')
param deployRatingEngine bool = false

@description('rm04-spec D2 — the worker image, pinned by digest. Empty (default) resolves to a bootstrap placeholder on the shared ACR at the module call site below — a param default cannot reference another resource\'s output (BCP072), so this mirrors how containerApp/containerAppJob resolve their own placeholder imageName inline.')
param ratingEngineImageName string = ''

@description('rm04-spec D6 — stamped into udr_rated.rating_engine_version per row (Inv #12). The pipeline overwrites this with the real deployed digest/tag, mirroring the app image tag pattern.')
param ratingEngineVersion string = 'bootstrap'

// rm05-spec D2 — the ONE unit that turns on external ingress on
// rating-engine, and only behind Easy Auth. Independent of, and only
// meaningful alongside, deployRatingEngine=true — deploying this true while
// deployRatingEngine is false fails (easyAuth references
// ratingEngineContainerApp's output, which doesn't exist when that module
// is skipped), which is the correct fail-fast: rm05 depends on rm04
// (spec header).
@description('Gates rm05: external ingress on rating-engine + its Easy Auth authConfig + diagnostics. Leave false until the Entra app registration, Workflow.Admin role, Billing Ops group and assignment-required are provisioned (Implementation §1/§2) and the client secret is in Key Vault (D8).')
param deployEasyAuth bool = false

@description('rm05 D6 — corporate CIDR ranges allowed through rating-engine\'s ingress once deployEasyAuth is true. Org-specific — supplied at deploy time (e.g. `--parameters corporateIpAllowList=$(CORPORATE_CIDR_RANGES)`), never committed as literals. Left empty/unused while deployEasyAuth is false; required + non-empty (enforced in easy-auth.bicep) once it is true.')
param corporateIpAllowList array = []

@description('rm05 D3 — the separate `rating-engine` Entra app registration\'s client ID (Implementation §1, provisioning prerequisite). Same tenant as entraTenantId above, distinct app id from microsoftClientId.')
param ratingEngineEntraClientId string = ''

var namePrefix = 'ebill-${environmentName}'
// ACR and Key Vault names must be globally unique (DNS-resolvable). A prefix
// alone risks collisions in shared tenants/clouds; mix in a deterministic
// per-resource-group suffix. The pipeline reads the actual names from this
// template's outputs.
var uniqueSuffix = uniqueString(resourceGroup().id)

resource appManagedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-app-mi'
  location: location
}

resource migrateManagedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-migrate-mi'
  location: location
}

// rm04-spec Implementation §3 — a dedicated identity for the rating engine
// (D1: "not a namespace on the bill run's engine" — a dedicated Container
// App gets a dedicated identity too). Created unconditionally like the two
// above (identities are free); the resources that actually USE it are
// gated by deployRatingEngine.
resource ratingEngineManagedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-rating-engine-mi'
  location: location
}

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${namePrefix}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
  }
}

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2023-05-01' = {
  name: '${namePrefix}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

module acr 'modules/acr.bicep' = {
  name: 'acr'
  params: {
    location: location
    acrName: take(replace('${namePrefix}acr${uniqueSuffix}', '-', ''), 50)
    appManagedIdentityPrincipalId: appManagedIdentity.properties.principalId
    migrateManagedIdentityPrincipalId: migrateManagedIdentity.properties.principalId
    // Empty when the engine is not deployed — the module skips the AcrPull
    // assignment on '' (least privilege: no unused grant on the shared ACR).
    ratingEngineManagedIdentityPrincipalId: deployRatingEngine ? ratingEngineManagedIdentity.properties.principalId : ''
  }
}

module keyVault 'modules/key-vault.bicep' = {
  name: 'keyVault'
  params: {
    location: location
    keyVaultName: take('${namePrefix}-kv-${uniqueSuffix}', 24)
    appManagedIdentityPrincipalId: appManagedIdentity.properties.principalId
    migrateManagedIdentityPrincipalId: migrateManagedIdentity.properties.principalId
    pipelineServicePrincipalId: pipelineServicePrincipalId
    // Empty when the engine is not deployed — the module skips the Secrets
    // User assignment on '' (least privilege: no unused grant on the shared KV).
    ratingEngineManagedIdentityPrincipalId: deployRatingEngine ? ratingEngineManagedIdentity.properties.principalId : ''
  }
}

module postgres 'modules/postgres.bicep' = {
  name: 'postgres'
  params: {
    postgresServerName: postgresServerName
    allowedExtensions: allowedExtensions
    sharedPreloadLibraries: sharedPreloadLibraries
  }
}

module containerApp 'modules/container-app.bicep' = if (deployWorkloads) {
  name: 'containerApp'
  params: {
    location: location
    containerAppName: '${namePrefix}-app'
    containerAppsEnvironmentId: containerAppsEnvironment.id
    acrLoginServer: acr.outputs.acrLoginServer
    keyVaultUri: keyVault.outputs.keyVaultUri
    appManagedIdentityId: appManagedIdentity.id
    // Placeholder tag — the pipeline's `deploy` stage immediately overwrites
    // this with the real `$(Build.BuildId)-$(Build.SourceVersion)` tag.
    imageName: '${acr.outputs.acrLoginServer}/enterprise-billing-app:bootstrap'
    appBaseUrl: 'https://${namePrefix}-app.${containerAppsEnvironment.properties.defaultDomain}'
    minReplicas: minReplicas
    maxReplicas: maxReplicas
    entraTenantId: entraTenantId
    microsoftClientId: microsoftClientId
    appTimezone: appTimezone
  }
}

module containerAppJob 'modules/container-app-job.bicep' = if (deployWorkloads) {
  name: 'containerAppJob'
  params: {
    location: location
    jobName: '${namePrefix}-migrate-job'
    containerAppsEnvironmentId: containerAppsEnvironment.id
    acrLoginServer: acr.outputs.acrLoginServer
    keyVaultUri: keyVault.outputs.keyVaultUri
    migrateManagedIdentityId: migrateManagedIdentity.id
    imageName: '${acr.outputs.acrLoginServer}/enterprise-billing-app:bootstrap'
  }
}

// rm04-spec D4/Implementation §4 — the rating engine's four storage
// locations. Created unconditionally alongside deployRatingEngine's other
// resources is unnecessary risk before the D0 spike passes, so this is
// gated the same way the Container App below is.
module ratingEngineStorage 'modules/rating-engine-storage.bicep' = if (deployRatingEngine) {
  name: 'ratingEngineStorage'
  params: {
    location: location
    storageAccountName: take(replace('${namePrefix}ratingstg${uniqueSuffix}', '-', ''), 24)
    ratingEngineManagedIdentityPrincipalId: ratingEngineManagedIdentity.properties.principalId
  }
}

// rm04-spec Implementation §3 — the `rating-engine` Container App. Gated by
// deployRatingEngine (D0 — not deployed until the process-runner spike
// passes on a real environment; see the param comment above).
module ratingEngineContainerApp 'modules/rating-engine-container-app.bicep' = if (deployRatingEngine) {
  name: 'ratingEngineContainerApp'
  params: {
    location: location
    containerAppName: '${namePrefix}-rating-engine'
    containerAppsEnvironmentId: containerAppsEnvironment.id
    acrLoginServer: acr.outputs.acrLoginServer
    keyVaultUri: keyVault.outputs.keyVaultUri
    ratingEngineManagedIdentityId: ratingEngineManagedIdentity.id
    // Placeholder tag — the containerize_rating_engine pipeline stage's
    // deploy step (once wired up alongside the app's own blue-green deploy
    // stage) overwrites this with the real pushed digest/tag, mirroring
    // containerApp/containerAppJob above.
    imageName: empty(ratingEngineImageName) ? '${acr.outputs.acrLoginServer}/rating-engine:bootstrap' : ratingEngineImageName
    ratingEngineVersion: ratingEngineVersion
    postgresServerFqdn: postgres.outputs.postgresServerFqdn
    storageAccountName: ratingEngineStorage!.outputs.storageAccountName
    landingShareName: ratingEngineStorage!.outputs.landingShareName
    kestraInternalContainerName: ratingEngineStorage!.outputs.kestraInternalContainerName
    enableEasyAuthIngress: deployEasyAuth
    corporateIpAllowList: corporateIpAllowList
  }
}

// rm05-spec — the Easy Auth authConfig + diagnostics on the rating-engine
// Container App above (D2: rm05 depends on rm04, Implementation §3/§5).
// Referencing ratingEngineContainerApp's output means this module cannot
// deploy unless that one did — deployEasyAuth=true with
// deployRatingEngine=false fails loudly rather than deploying nothing.
module easyAuth 'modules/easy-auth.bicep' = if (deployEasyAuth) {
  name: 'easyAuth'
  params: {
    containerAppName: ratingEngineContainerApp!.outputs.ratingEngineAppName
    containerAppsEnvironmentId: containerAppsEnvironment.id
    logAnalyticsWorkspaceId: logAnalytics.id
    logAnalyticsWorkspaceName: logAnalytics.name
    ratingEngineClientId: ratingEngineEntraClientId
    entraTenantId: entraTenantId
    corporateIpAllowList: corporateIpAllowList
  }
}

output appFqdn string = deployWorkloads ? containerApp!.outputs.fqdn : ''
output acrLoginServer string = acr.outputs.acrLoginServer
output keyVaultName string = keyVault.outputs.keyVaultName
output appManagedIdentityPrincipalId string = appManagedIdentity.properties.principalId
output migrateManagedIdentityPrincipalId string = migrateManagedIdentity.properties.principalId
output ratingEngineManagedIdentityPrincipalId string = ratingEngineManagedIdentity.properties.principalId
