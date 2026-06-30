// um30-spec §"3. Infrastructure as Code (Bicep)" — main.bicep. Orchestrates
// all modules, parameterized per environment via parameters/*.bicepparam.
@allowed(['dev', 'staging', 'prod'])
param environmentName string
param location string = resourceGroup().location
param postgresServerName string

// Full-replacement server settings (um27) — passed explicitly to the postgres
// module, which requires them so a hidden default can't clobber the server's
// existing config. Override per-environment to carry any extension/library the
// server already relies on. Changing sharedPreloadLibraries needs a one-time
// server restart.
param allowedExtensions string = 'PG_PARTMAN,PG_CRON,PGCRYPTO'
param sharedPreloadLibraries string = 'pg_cron'

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

@description('Gates the Container App + migrate Job (phase-2 workloads). Deploy with false first so the Key Vault exists and its secret references can be populated + the ACR image pushed, then true.')
param deployWorkloads bool = true

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

output appFqdn string = deployWorkloads ? containerApp!.outputs.fqdn : ''
output acrLoginServer string = acr.outputs.acrLoginServer
output keyVaultName string = keyVault.outputs.keyVaultName
output appManagedIdentityPrincipalId string = appManagedIdentity.properties.principalId
output migrateManagedIdentityPrincipalId string = migrateManagedIdentity.properties.principalId
