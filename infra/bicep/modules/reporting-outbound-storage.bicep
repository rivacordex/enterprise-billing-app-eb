// rpt01-spec D7 (RF8) — the reporting outbound storage: a SEPARATE storage
// account (never the engine's, workflow-engine-storage.bicep) holding one Azure
// Files share per destination, each registered as a Container Apps Environment
// storage definition and mounted on the reporting-hosting engine at
// /data/outbound/<destination>/ (workflow-engine-container-app.bicep,
// enableReporting).
//
// Why a separate account: ACA mounts Azure Files with the ACCOUNT KEY (there is
// no Managed-Identity mount option), so a credential separate from the
// engine's landing share needs a separate account. The key is read here by
// listKeys() at deploy time and handed to the platform's storage definition
// only — it never crosses a module output, and never reaches Kestra, the
// runtime or the repository (D3).
//
// Why one share per destination (rpt04 D1 amendment): Azure Files can't scope
// read access to a folder, so each reader gets access to its own share only.
// Reader access itself is out of scope here; it is agreed when a destination
// is set up (RF-OI2), and grants access to this account's share only.
//
// Outbound destinations — audience recorded here and in
// workflow-management/flows/reporting/README.md (_Outbound destinations_):
//
//   outbound_dir        share            readers                    since
//   _platform-check/    platform-check   none (no external reader)  rpt01
param location string
param storageAccountName string

@description('Container Apps Environment the storage definitions are registered on (the engine\'s environment).')
param containerAppsEnvironmentId string

@description('Prefix for the environment storage definitions, one per destination (`<prefix>-platform-check`). MUST be unique per instance on a shared environment, as landingEnvStorageName.')
param envStorageName string = 'reporting-outbound'

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    // Secure transfer required: on Azure Files this refuses unencrypted SMB.
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    // Left enabled: the ACA Azure Files mount authenticates with the account
    // key (as the engine's `landing` mount does).
    allowSharedKeyAccess: true
    // Encryption at rest, stated explicitly: Microsoft-managed keys on the
    // file and blob services, plus the infrastructure (second) layer.
    // requireInfrastructureEncryption and keyType are fixed at creation, so
    // they hold only for an account created with them; changing them later
    // means recreating the account.
    encryption: {
      keySource: 'Microsoft.Storage'
      requireInfrastructureEncryption: true
      services: {
        file: {
          enabled: true
          keyType: 'Account'
        }
        blob: {
          enabled: true
          keyType: 'Account'
        }
      }
    }
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-01-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    protocolSettings: {
      smb: {
        // SMB 3.1.1 with AES-256-GCM only — the transport guarantee for the
        // outbound egress (rptmgmt-architecture.md §7, RF8).
        versions: 'SMB3.1.1'
        channelEncryption: 'AES-256-GCM'
      }
    }
  }
}

// _platform-check/ — report-platform-check (rpt01). No external reader.
resource platformCheckShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-01-01' = {
  parent: fileService
  name: 'platform-check'
}

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2023-05-01' existing = {
  name: last(split(containerAppsEnvironmentId, '/'))
}

resource platformCheckEnvStorage 'Microsoft.App/managedEnvironments/storages@2023-05-01' = {
  parent: containerAppsEnvironment
  name: '${envStorageName}-platform-check'
  properties: {
    azureFile: {
      accountName: storageAccount.name
      accountKey: storageAccount.listKeys().keys[0].value
      shareName: platformCheckShare.name
      accessMode: 'ReadWrite'
    }
  }
}

output storageAccountName string = storageAccount.name
// The storage-definition name the engine's volume references — never the key.
output platformCheckEnvStorageName string = platformCheckEnvStorage.name
