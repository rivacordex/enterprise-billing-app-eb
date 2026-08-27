// rm04-spec Implementation §3 — the `rating-engine` Container App: a
// dedicated, process-runner Kestra OSS engine (D1/D2). Runs the worker image
// built from rating-engine/worker/Dockerfile against the `kestra` database
// (rm03a) as `kestra_engine`.
//
// D0 CAVEAT — this module has not been validated against a real Container
// Apps environment. The env var names below for Kestra's datasource, Azure
// Blob storage plugin, and Basic Auth follow Kestra OSS's documented
// configuration surface as of the pinned version, but the process-runner
// spike (D0, Open item 7) — the thing that actually proves a custom Kestra
// image on ACA's process runner can read/write Azure Files, read/write Blob
// through Kestra internal storage, and resolve its image tag — has not been
// run. See ratemgmt-progress-tracker.md. Confirm every KESTRA_* key against
// the pinned release's actual `kestra.yml` schema before first deploy.
//
// activeRevisionsMode 'Single' (not 'Multiple' like the app) — the engine is
// stateful against one DB via the OSS JDBC queue; blue-green multi-revision
// is a deliberate later decision (D3, Implementation §3), not v1 default.
// Ingress disabled by default (D8) — rm05 turns on external ingress behind
// Easy Auth; rm04 must never expose the UI unprotected.
param location string
param containerAppName string
param containerAppsEnvironmentId string
param acrLoginServer string
param keyVaultUri string
param ratingEngineManagedIdentityId string
param imageName string

@description('The deployed image digest/tag, stamped per-row into udr_rated.rating_engine_version (D6, Inv #12) — NOT NULL, no other source.')
param ratingEngineVersion string

@description('kestra database host (the existing Flexible Server FQDN, rm03/rm03a) — the `kestra` DB itself, not the billing DB.')
param postgresServerFqdn string

@description('Storage account name backing landing/ (Files) + archive/error/logs/kestra-internal (Blob) — rating-engine-storage.bicep output.')
param storageAccountName string

@description('Azure Files share name for landing/ — rating-engine-storage.bicep output.')
param landingShareName string

@description('Blob container name for Kestra internal storage — rating-engine-storage.bicep output.')
param kestraInternalContainerName string

@description('Storage account key for the ACA environment Files mount ONLY (platform-level SMB auth — see rating-engine-storage.bicep; never exposed to the engine as an app-level credential).')
@secure()
param storageAccountKey string

@description('true = ingress fully internal to the Container Apps Environment (no external DNS at all); false = disabled (D8 default until rm05).')
param internalIngress bool = false

param minReplicas int = 1
param maxReplicas int = 1

// Azure Files storage definition at the Container Apps Environment level —
// a sibling resource to the environment, referenced by name in the volume
// mount below (existing environment, referenced not created — D1 shared
// platform footprint).
resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2023-05-01' existing = {
  name: last(split(containerAppsEnvironmentId, '/'))
}

resource landingFileStorage 'Microsoft.App/managedEnvironments/storages@2023-05-01' = {
  parent: containerAppsEnvironment
  name: 'rating-landing'
  properties: {
    azureFile: {
      accountName: storageAccountName
      accountKey: storageAccountKey
      shareName: landingShareName
      accessMode: 'ReadWrite'
    }
  }
}

resource ratingEngineApp 'Microsoft.App/containerApps@2023-05-01' = {
  name: containerAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${ratingEngineManagedIdentityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppsEnvironmentId
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [
        {
          server: acrLoginServer
          identity: ratingEngineManagedIdentityId
        }
      ]
      secrets: [
        // D5 — three of the four credentials as Key Vault secret refs (the
        // fourth, internal-storage, is Managed-Identity-only — see
        // rating-engine-storage.bicep's role assignments, no KV secret here).
        {
          name: 'kestra-basic-auth-password'
          keyVaultUrl: '${keyVaultUri}secrets/kestra-basic-auth-password'
          identity: ratingEngineManagedIdentityId
        }
        {
          name: 'pg-connection-string-rating-runtime'
          keyVaultUrl: '${keyVaultUri}secrets/pg-connection-string-rating-runtime'
          identity: ratingEngineManagedIdentityId
        }
        {
          name: 'pg-connection-string-kestra-engine'
          keyVaultUrl: '${keyVaultUri}secrets/pg-connection-string-kestra-engine'
          identity: ratingEngineManagedIdentityId
        }
      ]
      ingress: internalIngress
        ? {
            external: false
            targetPort: 8080
            traffic: [{ latestRevision: true, weight: 100 }]
          }
        : null
    }
    template: {
      containers: [
        {
          name: 'rating-engine'
          image: imageName
          env: [
            // D6 — resolved per row by a task, never per batch (Inv #12).
            { name: 'RATING_ENGINE_VERSION', value: ratingEngineVersion }

            // D7 — datasource is the `kestra` DB via `kestra_engine`, NOT
            // the billing DB. Kestra runs its own startup migrations here
            // (kestra_engine holds CREATE on this DB only — rm03a).
            { name: 'KESTRA_DATASOURCES_POSTGRES_URL', value: 'jdbc:postgresql://${postgresServerFqdn}:5432/kestra' }
            { name: 'KESTRA_DATASOURCES_POSTGRES_USERNAME', value: 'kestra_engine' }
            { name: 'KESTRA_DATASOURCES_POSTGRES_PASSWORD', secretRef: 'pg-connection-string-kestra-engine' }

            // D7 — storage.type: azure, internal storage → the
            // kestra-internal Blob container (NOT the container filesystem,
            // code-standards §3.4). Auth is Managed Identity
            // (DefaultAzureCredential) per D5's stated preference — CONFIRM
            // the pinned Kestra Azure Blob plugin version actually supports
            // MI auth during the D0 spike; if it does not, this falls back
            // to a SAS/connection-string KV secret and D5's credential count
            // changes from three KV secrets to four.
            { name: 'KESTRA_STORAGE_TYPE', value: 'azure' }
            { name: 'KESTRA_STORAGE_AZURE_ACCOUNT_NAME', value: storageAccountName }
            { name: 'KESTRA_STORAGE_AZURE_CONTAINER', value: kestraInternalContainerName }
            { name: 'KESTRA_STORAGE_AZURE_ENDPOINT', value: 'https://${storageAccountName}.blob.${environment().suffixes.storage}' }

            // D7 — Basic Auth from the one shared credential; D5's Kestra
            // Basic Auth entry. Username is non-secret (fixed operator
            // login name); only the password is a KV secret.
            { name: 'KESTRA_SERVER_BASIC_AUTH_USERNAME', value: 'rating-ops' }
            { name: 'KESTRA_SERVER_BASIC_AUTH_PASSWORD', secretRef: 'kestra-basic-auth-password' }

            // D7 — default namespace `rating`.
            { name: 'KESTRA_SERVER_DEFAULT_NAMESPACE', value: 'rating' }

            // code-standards §3.8 — flow tasks resolve rating_runtime's
            // password via `{{ secret('RATING_RUNTIME_PASSWORD') }}`, never
            // an interpolated env var. Kestra's env-based secrets backend
            // reads `SECRET_<NAME>`.
            { name: 'SECRET_RATING_RUNTIME_PASSWORD', secretRef: 'pg-connection-string-rating-runtime' }
          ]
          volumeMounts: [
            {
              volumeName: 'landing'
              mountPath: '/data/landing'
            }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/health', port: 8080 }
              initialDelaySeconds: 30
              periodSeconds: 10
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: { path: '/health', port: 8080 }
              periodSeconds: 10
              successThreshold: 2
            }
          ]
        }
      ]
      volumes: [
        {
          name: 'landing'
          storageType: 'AzureFile'
          storageName: landingFileStorage.name
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
}

output ratingEngineAppName string = ratingEngineApp.name
