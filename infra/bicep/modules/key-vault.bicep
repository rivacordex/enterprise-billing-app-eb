// um30-spec §"3. Infrastructure as Code (Bicep)" — modules/key-vault.bicep.
// Soft-delete + purge protection enabled; RBAC authorization (no legacy
// access policies). enabledForTemplateDeployment is left false — secrets
// are never read into ARM/Bicep template outputs.
param location string
param keyVaultName string
param appManagedIdentityPrincipalId string
param migrateManagedIdentityPrincipalId string
param pipelineServicePrincipalId string

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    enableRbacAuthorization: true
    enabledForTemplateDeployment: false
  }
}

var keyVaultSecretsUserRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)
var keyVaultSecretsOfficerRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
)

// App Managed Identity — read-only (Secrets User): no write/delete.
resource appMiRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, appManagedIdentityPrincipalId, keyVaultSecretsUserRoleId)
  scope: keyVault
  properties: {
    roleDefinitionId: keyVaultSecretsUserRoleId
    principalId: appManagedIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Migration Managed Identity — also read-only; it fetches the app_migrate
// connection string from this same vault.
resource migrateMiRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, migrateManagedIdentityPrincipalId, keyVaultSecretsUserRoleId)
  scope: keyVault
  properties: {
    roleDefinitionId: keyVaultSecretsUserRoleId
    principalId: migrateManagedIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Pipeline service principal — Secrets Officer, write access for initial
// setup only (rotating secret values). Not used at app runtime.
resource pipelineRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, pipelineServicePrincipalId, keyVaultSecretsOfficerRoleId)
  scope: keyVault
  properties: {
    roleDefinitionId: keyVaultSecretsOfficerRoleId
    principalId: pipelineServicePrincipalId
    principalType: 'ServicePrincipal'
  }
}

output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
