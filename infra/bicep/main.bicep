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
// runner spike passes." The workflow-engine module (storage + Container App)
// is authored and ready, but the spike proving a custom Kestra image on
// ACA's process runner actually works has NOT been run (no Azure access in
// the session that authored this). Defaults to false so this module cannot
// be deployed by accident; flip to true only after the spike (Open item 7)
// passes and its result is recorded in ratemgmt-progress-tracker.md.
@description('Gates the workflow-engine Container App + storage (rm04). Leave false until the D0 process-runner spike has passed on a real environment.')
param deployWorkflowEngine bool = false

// wfm01 §4b / wfm-architecture §5 — logical→physical engine topology, a single
// deploy parameter. `collapsed` (default): ONE `workflow-engine` instance hosting
// both the `rating` and `billrun` namespaces (the base deployment; carries the
// recorded OSS money-logic-isolation accepted risk, wfm §6). `split-by-module`:
// TWO instances (`workflow-engine-rating`, `workflow-engine-billrun`), each with
// its own managed identity + storage; the app repoints `billrun` to the second
// via the env templates — NO app-code change (engine-registry is by-name).
// `enterprise`: phase-2 target. NOTE — it currently deploys the SAME
// single-instance shape as `collapsed` (splitByModule stays false); the
// Enterprise-edition image + scoped per-flow tokens that actually remove the
// shared-instance risk are not modelled in this bicep yet, so selecting it today
// is functionally collapsed. Flipping this param + the matching env template is
// the whole topology change.
@allowed(['collapsed', 'split-by-module', 'enterprise'])
param topology string = 'collapsed'

@description('rm04-spec D2 — the worker image, pinned by digest. Empty (default) resolves to a bootstrap placeholder on the shared ACR at the module call site below — a param default cannot reference another resource\'s output (BCP072), so this mirrors how containerApp/containerAppJob resolve their own placeholder imageName inline.')
param workflowEngineImageName string = ''

@description('rm04-spec D6 — stamped into udr_rated.rating_engine_version per row (Inv #12). The pipeline overwrites this with the real deployed digest/tag, mirroring the app image tag pattern.')
param workflowEngineVersion string = 'bootstrap'

// rm05-spec D2 — the ONE unit that turns on external ingress on
// workflow-engine, and only behind Easy Auth. Independent of, and only
// meaningful alongside, deployWorkflowEngine=true — deploying this true while
// deployWorkflowEngine is false fails (easyAuth references
// workflowEngineContainerApp's output, which doesn't exist when that module
// is skipped), which is the correct fail-fast: rm05 depends on rm04
// (spec header).
@description('Gates rm05: external ingress on workflow-engine + its Easy Auth authConfig + diagnostics. Leave false until the Entra app registration, Workflow.Admin role, Billing Ops group and assignment-required are provisioned (Implementation §1/§2) and the client secret is in Key Vault (D8).')
param deployEasyAuth bool = false

@description('rm05 D6 — corporate CIDR ranges allowed through workflow-engine\'s ingress once deployEasyAuth is true. Org-specific — supplied at deploy time (e.g. `--parameters corporateIpAllowList=$(CORPORATE_CIDR_RANGES)`), never committed as literals. Left empty/unused while deployEasyAuth is false; required + non-empty (enforced in easy-auth.bicep) once it is true.')
param corporateIpAllowList array = []

@description('rm05 D3 — the separate `workflow-engine` Entra app registration\'s client ID (Implementation §1, provisioning prerequisite). Same tenant as entraTenantId above, distinct app id from microsoftClientId.')
param workflowEngineEntraClientId string = ''

var namePrefix = 'ebill-${environmentName}'
// ACR and Key Vault names must be globally unique (DNS-resolvable). A prefix
// alone risks collisions in shared tenants/clouds; mix in a deterministic
// per-resource-group suffix. The pipeline reads the actual names from this
// template's outputs.
var uniqueSuffix = uniqueString(resourceGroup().id)
// wfm01 §4b — true only under the split-by-module topology (two engine instances).
var splitByModule = topology == 'split-by-module'

resource appManagedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-app-mi'
  location: location
}

resource migrateManagedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-migrate-mi'
  location: location
}

// A dedicated identity for the workflow engine. Created unconditionally like
// the two above (identities are free); the resources that USE it are gated by
// deployWorkflowEngine. Under `collapsed` this is the single engine's identity;
// under `split-by-module` it is the RATING instance's identity.
resource workflowEngineManagedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-workflow-engine-mi'
  location: location
}

// wfm01 §4b — second engine identity, used ONLY by the `billrun` instance under
// the split-by-module topology. Created unconditionally (free); it receives ACR
// pull + KV Secrets User grants only when `splitByModule` puts it in the arrays
// passed to the acr/key-vault modules below, and is otherwise unused.
resource workflowEngineBillrunManagedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-workflow-engine-billrun-mi'
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
    // wfm01 §4b — [] when the engine is not deployed (no unused AcrPull grant);
    // one principal under `collapsed`; both engine identities under `split-by-module`.
    workflowEngineManagedIdentityPrincipalIds: deployWorkflowEngine
      ? (splitByModule
          ? [workflowEngineManagedIdentity.properties.principalId, workflowEngineBillrunManagedIdentity.properties.principalId]
          : [workflowEngineManagedIdentity.properties.principalId])
      : []
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
    // wfm01 §4b — [] when the engine is not deployed; one principal under
    // `collapsed`; both engine identities under `split-by-module`.
    workflowEngineManagedIdentityPrincipalIds: deployWorkflowEngine
      ? (splitByModule
          ? [workflowEngineManagedIdentity.properties.principalId, workflowEngineBillrunManagedIdentity.properties.principalId]
          : [workflowEngineManagedIdentity.properties.principalId])
      : []
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

// ── wfm01 §4b — COLLAPSED topology (default): ONE workflow-engine instance
// hosting both namespaces. Gated by deployWorkflowEngine AND !splitByModule.
// rm04-spec D4/Implementation §4 — the engine's four storage locations.
module workflowEngineStorage 'modules/workflow-engine-storage.bicep' = if (deployWorkflowEngine && !splitByModule) {
  name: 'workflowEngineStorage'
  params: {
    location: location
    storageAccountName: take(replace('${namePrefix}ratingstg${uniqueSuffix}', '-', ''), 24)
    workflowEngineManagedIdentityPrincipalId: workflowEngineManagedIdentity.properties.principalId
  }
}

// rm04-spec Implementation §3 — the collapsed `workflow-engine` Container App.
module workflowEngineContainerApp 'modules/workflow-engine-container-app.bicep' = if (deployWorkflowEngine && !splitByModule) {
  name: 'workflowEngineContainerApp'
  params: {
    location: location
    containerAppName: '${namePrefix}-workflow-engine'
    containerAppsEnvironmentId: containerAppsEnvironment.id
    acrLoginServer: acr.outputs.acrLoginServer
    keyVaultUri: keyVault.outputs.keyVaultUri
    workflowEngineManagedIdentityId: workflowEngineManagedIdentity.id
    // Placeholder tag — the containerize_workflow_engine pipeline stage's
    // deploy step overwrites this with the real pushed digest/tag, mirroring
    // containerApp/containerAppJob above.
    imageName: empty(workflowEngineImageName) ? '${acr.outputs.acrLoginServer}/workflow-engine:bootstrap' : workflowEngineImageName
    workflowEngineVersion: workflowEngineVersion
    postgresServerFqdn: postgres.outputs.postgresServerFqdn
    storageAccountName: workflowEngineStorage!.outputs.storageAccountName
    landingShareName: workflowEngineStorage!.outputs.landingShareName
    kestraInternalContainerName: workflowEngineStorage!.outputs.kestraInternalContainerName
    enableEasyAuthIngress: deployEasyAuth
    corporateIpAllowList: corporateIpAllowList
  }
}

// ── wfm01 §4b — SPLIT-BY-MODULE topology: TWO instances, each the SAME shared
// image (worker/workflow-engine) instantiated with its own name, managed
// identity, and storage. Gated by deployWorkflowEngine AND splitByModule.
// NOTE (wfm01 scope): the module is reused verbatim, so the `billrun` instance
// still carries rating-scoped env (RATING_ENGINE_VERSION, rating_runtime secret,
// landing mount, default-namespace `rating`). Making it billrun-native is
// billing phase 2 — wfm01 is a positioning/layout reframe, not a functional
// billrun-engine build. Flows still deploy namespace-qualified (§7b).
module workflowEngineRatingStorage 'modules/workflow-engine-storage.bicep' = if (deployWorkflowEngine && splitByModule) {
  name: 'workflowEngineRatingStorage'
  params: {
    location: location
    storageAccountName: take(replace('${namePrefix}wfrstg${uniqueSuffix}', '-', ''), 24)
    workflowEngineManagedIdentityPrincipalId: workflowEngineManagedIdentity.properties.principalId
  }
}

module workflowEngineBillrunStorage 'modules/workflow-engine-storage.bicep' = if (deployWorkflowEngine && splitByModule) {
  name: 'workflowEngineBillrunStorage'
  params: {
    location: location
    storageAccountName: take(replace('${namePrefix}wfbstg${uniqueSuffix}', '-', ''), 24)
    workflowEngineManagedIdentityPrincipalId: workflowEngineBillrunManagedIdentity.properties.principalId
  }
}

module workflowEngineRatingContainerApp 'modules/workflow-engine-container-app.bicep' = if (deployWorkflowEngine && splitByModule) {
  name: 'workflowEngineRatingContainerApp'
  params: {
    location: location
    containerAppName: '${namePrefix}-workflow-engine-rating'
    containerAppsEnvironmentId: containerAppsEnvironment.id
    acrLoginServer: acr.outputs.acrLoginServer
    keyVaultUri: keyVault.outputs.keyVaultUri
    workflowEngineManagedIdentityId: workflowEngineManagedIdentity.id
    imageName: empty(workflowEngineImageName) ? '${acr.outputs.acrLoginServer}/workflow-engine:bootstrap' : workflowEngineImageName
    workflowEngineVersion: workflowEngineVersion
    postgresServerFqdn: postgres.outputs.postgresServerFqdn
    storageAccountName: workflowEngineRatingStorage!.outputs.storageAccountName
    landingShareName: workflowEngineRatingStorage!.outputs.landingShareName
    kestraInternalContainerName: workflowEngineRatingStorage!.outputs.kestraInternalContainerName
    // Split-instance ingress/Easy Auth is a later decision (rm05 dual-instance);
    // wfm01 leaves it internal/disabled.
    enableEasyAuthIngress: false
    corporateIpAllowList: []
  }
}

module workflowEngineBillrunContainerApp 'modules/workflow-engine-container-app.bicep' = if (deployWorkflowEngine && splitByModule) {
  name: 'workflowEngineBillrunContainerApp'
  params: {
    location: location
    containerAppName: '${namePrefix}-workflow-engine-billrun'
    containerAppsEnvironmentId: containerAppsEnvironment.id
    acrLoginServer: acr.outputs.acrLoginServer
    keyVaultUri: keyVault.outputs.keyVaultUri
    workflowEngineManagedIdentityId: workflowEngineBillrunManagedIdentity.id
    imageName: empty(workflowEngineImageName) ? '${acr.outputs.acrLoginServer}/workflow-engine:bootstrap' : workflowEngineImageName
    workflowEngineVersion: workflowEngineVersion
    postgresServerFqdn: postgres.outputs.postgresServerFqdn
    storageAccountName: workflowEngineBillrunStorage!.outputs.storageAccountName
    landingShareName: workflowEngineBillrunStorage!.outputs.landingShareName
    kestraInternalContainerName: workflowEngineBillrunStorage!.outputs.kestraInternalContainerName
    // Distinct env-storage name + default namespace so this second instance does
    // not collide with the rating instance's `rating-landing` storage definition
    // on the shared Container Apps Environment, and defaults unqualified deploys
    // to `billrun`.
    landingEnvStorageName: 'billrun-landing'
    defaultNamespace: 'billrun'
    enableEasyAuthIngress: false
    corporateIpAllowList: []
  }
}

// wfm01 §4b LIMITATION (deferred to billing phase 2): the two split instances
// above reuse the same module and still point at the ONE `kestra` database as
// `kestra_engine` — i.e. they share the OSS JDBC queue/state, so split-by-module
// isolates the container/identity/storage but NOT the engine's work queue.
// True queue isolation needs a second `kestra` DB (or Kestra Enterprise, the
// `enterprise` topology). Do not treat split-by-module as full money-logic
// isolation until that lands; the collapsed default's accepted risk (wfm §6)
// effectively still applies to the shared queue.

// rm05-spec — the Easy Auth authConfig + diagnostics on the workflow-engine
// Container App above (D2: rm05 depends on rm04, Implementation §3/§5).
// Referencing workflowEngineContainerApp's output means this module cannot
// deploy unless that one did — deployEasyAuth=true with
// deployWorkflowEngine=false fails loudly rather than deploying nothing.
// wfm01 §4b: scoped to the COLLAPSED topology. Under split-by-module BOTH engine
// instances run with enableEasyAuthIngress=false (internal/disabled ingress), so
// there is no external surface to protect and easy-auth is simply skipped — this
// is safe, NOT a silent hole. Per-split-instance Easy Auth (two front doors) is
// deferred (rm05 dual-instance).
module easyAuth 'modules/easy-auth.bicep' = if (deployEasyAuth && !splitByModule) {
  name: 'easyAuth'
  params: {
    containerAppName: workflowEngineContainerApp!.outputs.workflowEngineAppName
    containerAppsEnvironmentId: containerAppsEnvironment.id
    logAnalyticsWorkspaceId: logAnalytics.id
    logAnalyticsWorkspaceName: logAnalytics.name
    workflowEngineClientId: workflowEngineEntraClientId
    entraTenantId: entraTenantId
    corporateIpAllowList: corporateIpAllowList
  }
}

output appFqdn string = deployWorkloads ? containerApp!.outputs.fqdn : ''
output acrLoginServer string = acr.outputs.acrLoginServer
output keyVaultName string = keyVault.outputs.keyVaultName
output appManagedIdentityPrincipalId string = appManagedIdentity.properties.principalId
output migrateManagedIdentityPrincipalId string = migrateManagedIdentity.properties.principalId
output workflowEngineManagedIdentityPrincipalId string = workflowEngineManagedIdentity.properties.principalId
