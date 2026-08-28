// rm05-spec Implementation §5 (D7) — a diagnostic setting on the ENTRA
// TENANT exporting SignInLogs to the shared Log Analytics workspace.
//
// Deliberately NOT wired into main.bicep / deployed by the app pipeline.
// Tenant-scoped diagnostic settings (Microsoft.aadiam/diagnosticSettings)
// need a tenant-scoped deployment and a tenant-level role (Security
// Administrator or better) — a different privilege class than the
// resource-group Contributor the rest of this repo's Bicep assumes, and
// the same "Entra admin, documented, not application code" treatment
// Implementation §1/§2 give the app registration and the Billing Ops
// group. Apply by hand, once per tenant/environment:
//
//   az deployment tenant create \
//     --name rm05-entra-signin-diagnostics \
//     --location <location> \
//     --template-file infra/bicep/modules/entra-signin-diagnostics.bicep \
//     --parameters logAnalyticsWorkspaceId=<full LA workspace resource ID>
//
// See infra/docs/engine-access.md for the full provisioning order this
// step fits into and who is authorized to run it.
targetScope = 'tenant'

@description('Full resource ID of the shared Log Analytics workspace (main.bicep\'s `logAnalytics` resource in the target resource group) that also receives the Container App logs (easy-auth.bicep).')
param logAnalyticsWorkspaceId string

resource entraSignInDiagnostics 'Microsoft.aadiam/diagnosticSettings@2017-04-01' = {
  name: 'rating-engine-signin-logs'
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        category: 'SignInLogs'
        enabled: true
      }
    ]
  }
}
