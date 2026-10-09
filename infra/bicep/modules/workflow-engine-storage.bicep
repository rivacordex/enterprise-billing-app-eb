// rm04-spec D4/Implementation §4 — the rating engine's four storage
// locations plus its Kestra internal-storage container.
//
//   landing/          Azure Files (SMB) — upstream delivers by SMB, not
//                      negotiable from rating's side. Retention: until
//                      archived (rm09's problem, not a lifecycle rule here).
//   archive/          Azure Blob — the evidentiary record. 7-year lifecycle.
//   error/            Azure Blob — reject files with reason codes. 24-month.
//   logs/             Azure Blob — component log files pending sweep. 24-month.
//   kestra-internal/  Azure Blob — Kestra's own task-passing storage (a
//                      FIFTH, separate config item, not one of the four
//                      mounts). Never the container filesystem
//                      (code-standards §3.4). Engine-managed retention — no
//                      lifecycle rule.
//
// A NEW storage account: no Azure Blob/Files SDK or storage account exists
// in the app repo before rating (rm04-spec header note) — rating is the
// platform's first file storage.
param location string
param storageAccountName string
param workflowEngineManagedIdentityPrincipalId string

@description('Blob lifecycle retention for archive/, in days. 7 years = 2555 days (D4).')
param archiveRetentionDays int = 2555

@description('Blob lifecycle retention for error/ and logs/, in days. 24 months = 730 days (D4).')
param shortRetentionDays int = 730

// bm52 D1 — the billing app's artifact containers live on this account
// (main.bicep's enableBlobArtifacts: "artifacts share the engine's storage
// account"). True only on the account the app + billrun engine share — the
// collapsed instance's, or the billrun instance's under split-by-module.
@description('bm52 — declare the app-owned blob containers (appBlobContainers) on this account. Default false.')
param enableBlobArtifacts bool = false

@description('App-owned containers (billing). Declared so they exist before deploy; the app must never rely on createIfNotExists in prod.')
param appBlobContainers array = ['invoices', 'invoice-templates', 'invoice-assets']

// bm52 D3 / gate G16 — how the app authenticates to blob. `connectionString`
// (default, G16 interim): no role assignment, the app keeps the Key Vault
// connection string. `managedIdentity`: a container-scoped Storage Blob Data
// Contributor per app container for the app's user-assigned identity.
@allowed(['connectionString', 'managedIdentity'])
param appBlobAuth string = 'connectionString'

@description('bm52 D3 — principal (object) id of the app\'s user-assigned identity. Used only when appBlobAuth is managedIdentity.')
param appManagedIdentityPrincipalId string = ''

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    // NOT disabled: the Container Apps Environment's Azure Files mount
    // (workflow-engine-container-app.bicep) is provisioned at the PLATFORM
    // level via this account's key (an ARM listKeys() reference at deploy
    // time), which is how ACA's `Microsoft.App/managedEnvironments/storages`
    // resource authenticates SMB — there is no Managed-Identity mount option
    // for Azure Files on Container Apps as of this API version. The account
    // key is never surfaced to the ENGINE or to application code — the
    // engine's own Blob access (D5 internal-storage credential) stays
    // Managed-Identity-only via the role assignments below.
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-01-01' = {
  parent: storageAccount
  name: 'default'
}

resource landingShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-01-01' = {
  parent: fileService
  name: 'landing'
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-01-01' = {
  parent: storageAccount
  name: 'default'
}

resource archiveContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobService
  name: 'archive'
}

resource errorContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobService
  name: 'error'
}

resource logsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobService
  name: 'logs'
}

resource kestraInternalContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobService
  name: 'kestra-internal'
}

// bm52 D1 — the app's three containers. publicAccess is stated per container
// for review clarity (the account already disables public blob access).
// Declaring `invoices` where the app's createIfNotExists already made it is an
// idempotent PUT — no data moves. No immutability (WORM) policy in v1 (write-once
// is the app's ifNoneMatch '*', bm51; a container policy would block the
// transient run-report overwrite in `invoices`) and no lifecycle rule (Inv #44 —
// nothing deletes a version), so none of these appear in lifecyclePolicy below.
resource appContainers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [for name in appBlobContainers: if (enableBlobArtifacts) {
  parent: blobService
  name: name
  properties: { publicAccess: 'None' }
}]

// Lifecycle rules (D4). Scoped by container-name prefix match since a
// management policy is per-storage-account, not per-container. No rule for
// landing/ (Files, not covered by blob management policies) or
// kestra-internal/ (engine-managed).
resource lifecyclePolicy 'Microsoft.Storage/storageAccounts/managementPolicies@2023-01-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'archive-7-years'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: ['blockBlob']
              prefixMatch: ['archive/']
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: archiveRetentionDays
                }
              }
            }
          }
        }
        {
          name: 'error-24-months'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: ['blockBlob']
              prefixMatch: ['error/']
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: shortRetentionDays
                }
              }
            }
          }
        }
        {
          name: 'logs-24-months'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: ['blockBlob']
              prefixMatch: ['logs/']
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: shortRetentionDays
                }
              }
            }
          }
        }
      ]
    }
  }
}

var storageBlobDataContributorRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
)
var storageFileDataSmbShareContributorRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '0c867c2a-1d8c-454a-a3db-ab2ea1bdc8bb'
)

// D5 — "prefer a Managed Identity role assignment over a KV secret" for the
// internal-storage credential; scoped to the whole account since the engine
// reads/writes all four Blob locations plus kestra-internal.
resource workflowEngineBlobDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, workflowEngineManagedIdentityPrincipalId, storageBlobDataContributorRoleId)
  scope: storageAccount
  properties: {
    roleDefinitionId: storageBlobDataContributorRoleId
    principalId: workflowEngineManagedIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource workflowEngineFileDataSmbContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, workflowEngineManagedIdentityPrincipalId, storageFileDataSmbShareContributorRoleId)
  scope: storageAccount
  properties: {
    roleDefinitionId: storageFileDataSmbShareContributorRoleId
    principalId: workflowEngineManagedIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// bm52 D3 / G16 — the app's blob write grant under appBlobAuth=managedIdentity:
// one assignment PER CONTAINER, never the account (the account scope would also
// reach Kestra's archive/error/logs/kestra-internal). The role's Delete right is
// broader than the app needs — there is no built-in write-without-delete data
// role; write-once/no-delete are enforced in the app (bm51) and by review, and a
// custom role is out of scope. The engine's account-scoped grant above is
// untouched (the distributor reads `invoices/`).
resource appContainerBlobDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (name, i) in appBlobContainers: if (enableBlobArtifacts && appBlobAuth == 'managedIdentity') {
  name: guid(appContainers[i].id, appManagedIdentityPrincipalId, storageBlobDataContributorRoleId)
  scope: appContainers[i]
  properties: {
    roleDefinitionId: storageBlobDataContributorRoleId
    principalId: appManagedIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}]

// The account key is NEVER exported across a module boundary. The ACA
// Environment's Azure Files storage definition needs it (no MI mount option
// for Files on Container Apps — see the account's allowBlobPublicAccess
// comment above), but workflow-engine-container-app.bicep resolves it there via
// an `existing` reference + listKeys() — the same inline pattern the rest of
// this codebase uses (e.g. main.bicep's Log Analytics key). Exposing the id
// instead lets that consumer scope its `existing` reference precisely.
output storageAccountId string = storageAccount.id
output storageAccountName string = storageAccount.name
output fileEndpoint string = storageAccount.properties.primaryEndpoints.file
output blobEndpoint string = storageAccount.properties.primaryEndpoints.blob
output landingShareName string = landingShare.name
output archiveContainerName string = archiveContainer.name
output errorContainerName string = errorContainer.name
output logsContainerName string = logsContainer.name
output kestraInternalContainerName string = kestraInternalContainer.name
// bm52 D2 — app container name → resource id ({} when enableBlobArtifacts is false).
output appContainerIds object = enableBlobArtifacts
  ? toObject(
      appBlobContainers,
      name => name,
      name => resourceId('Microsoft.Storage/storageAccounts/blobServices/containers', storageAccount.name, 'default', name)
    )
  : {}
