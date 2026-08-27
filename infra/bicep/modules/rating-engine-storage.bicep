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
param ratingEngineManagedIdentityPrincipalId string

@description('Blob lifecycle retention for archive/, in days. 7 years = 2555 days (D4).')
param archiveRetentionDays int = 2555

@description('Blob lifecycle retention for error/ and logs/, in days. 24 months = 730 days (D4).')
param shortRetentionDays int = 730

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
    // (rating-engine-container-app.bicep) is provisioned at the PLATFORM
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
resource ratingEngineBlobDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, ratingEngineManagedIdentityPrincipalId, storageBlobDataContributorRoleId)
  scope: storageAccount
  properties: {
    roleDefinitionId: storageBlobDataContributorRoleId
    principalId: ratingEngineManagedIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource ratingEngineFileDataSmbContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, ratingEngineManagedIdentityPrincipalId, storageFileDataSmbShareContributorRoleId)
  scope: storageAccount
  properties: {
    roleDefinitionId: storageFileDataSmbShareContributorRoleId
    principalId: ratingEngineManagedIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Consumed ONLY by rating-engine-container-app.bicep to provision the ACA
// Environment's Azure Files storage definition (no MI mount option for
// Files on Container Apps — see the account's allowBlobPublicAccess comment
// above). Never surfaced to the engine itself or to application code. NOT
// marked @secure(): main.bicep dereferences this module conditionally
// (`ratingEngineStorage!.outputs...`, gated by deployRatingEngine), and
// Bicep's secure-output rule (BCP426) only allows a DIRECT module
// reference — the same restriction the rest of this codebase avoids simply
// by not using @secure() outputs (e.g. main.bicep's Log Analytics key is
// read inline via listKeys(), never passed across a module boundary).
#disable-next-line outputs-should-not-contain-secrets
output storageAccountKey string = storageAccount.listKeys().keys[0].value
output storageAccountName string = storageAccount.name
output fileEndpoint string = storageAccount.properties.primaryEndpoints.file
output blobEndpoint string = storageAccount.properties.primaryEndpoints.blob
output landingShareName string = landingShare.name
output archiveContainerName string = archiveContainer.name
output errorContainerName string = errorContainer.name
output logsContainerName string = logsContainer.name
output kestraInternalContainerName string = kestraInternalContainer.name
