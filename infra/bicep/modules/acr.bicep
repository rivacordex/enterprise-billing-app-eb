// um30-spec §"3. Infrastructure as Code (Bicep)" — modules/acr.bicep.
// Standard SKU, admin user disabled (auth is via Managed Identity /
// AcrPull role only — no shared admin credential).
//
// rm04-spec D1/Implementation §3 — the rating engine's Managed Identity also
// pulls the worker image from this SAME registry (shared platform footprint;
// rm04 owns only the image, not a second ACR). ratingEngineManagedIdentityPrincipalId
// defaults to '' so this module stays backward-compatible for callers that
// haven't wired the engine identity yet; empty skips the role assignment.
param location string
param acrName string
param appManagedIdentityPrincipalId string
param migrateManagedIdentityPrincipalId string
param ratingEngineManagedIdentityPrincipalId string = ''

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    adminUserEnabled: false
  }
}

var acrPullRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)

resource appAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, appManagedIdentityPrincipalId, acrPullRoleId)
  scope: acr
  properties: {
    roleDefinitionId: acrPullRoleId
    principalId: appManagedIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource migrateAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, migrateManagedIdentityPrincipalId, acrPullRoleId)
  scope: acr
  properties: {
    roleDefinitionId: acrPullRoleId
    principalId: migrateManagedIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource ratingEngineAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(ratingEngineManagedIdentityPrincipalId)) {
  name: guid(acr.id, ratingEngineManagedIdentityPrincipalId, acrPullRoleId)
  scope: acr
  properties: {
    roleDefinitionId: acrPullRoleId
    principalId: ratingEngineManagedIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

output acrLoginServer string = acr.properties.loginServer
output acrName string = acr.name
