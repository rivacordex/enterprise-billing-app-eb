// rm05-spec Implementation §3/§5/§6 — Container Apps Easy Auth (Entra) in
// front of the `rating-engine` Kestra UI (D1: Easy Auth, not Front Door).
// Declares the authConfig on the existing rating-engine Container App
// (rm04), the Container App diagnostic setting, and the Log Analytics
// table-level retention rm05 D7 requires. Deployed alongside
// rating-engine-container-app.bicep with enableEasyAuthIngress=true in the
// same pass — see that file's D2 comment for the ingress-ownership split.
//
// Deviation from the spec's literal `infra/easy-auth.bicep` path: this repo
// already deviated (rm04, ratemgmt-progress-tracker.md Architecture
// Decisions) to keep one Bicep module graph under `infra/bicep/modules/`
// rather than a separate rating-repo `infra/` tree. Same reasoning applies
// here — recorded, not a silent rename.
//
// Does NOT cover: the Entra app registration, the Workflow.Admin app role,
// the Billing Ops group, or assignment-required (D3/D4/D5) — those are
// Entra admin actions, not Bicep-managed resources (Implementation §1/§2).
// Does NOT cover the tenant-scoped Entra sign-in-log export — see the
// sibling entra-signin-diagnostics.bicep (different deployment scope/
// permission class, documented separately in engine-access.md).
param containerAppName string
param logAnalyticsWorkspaceId string
param logAnalyticsWorkspaceName string

@description('rm05 D3 — the separate `rating-engine` Entra app registration\'s client (application) ID. Same tenant as the app\'s own login registration, but a distinct app id (Implementation §1, provisioning prerequisite).')
param ratingEngineClientId string

@description('rm05 D3 — same tenant the app already federates to (ENTRA_TENANT_ID).')
param entraTenantId string

@description('rm05 Implementation §3 — the `rating-engine` registration\'s Application ID URI, used as the sole allowed audience. Defaults to the Entra-assigned `api://<clientId>` form; override if the registration was given a custom URI at provisioning.')
param ratingEngineAppIdUri string = 'api://${ratingEngineClientId}'

// rm05 D6/verification#14 — required, non-empty. This module's own
// resources don't consume the list directly (ingress lives in
// rating-engine-container-app.bicep, which receives the same value from
// main.bicep but does NOT enforce non-emptiness itself — seeing D2's
// comment there). Declaring it here as a required + @minLength(1) param,
// deployed in the SAME pass as the ingress change, is what makes an empty
// allow-list fail the whole deployment instead of silently shipping
// external ingress with no restriction.
@minLength(1)
param corporateIpAllowList array

resource ratingEngineApp 'Microsoft.App/containerApps@2023-05-01' existing = {
  name: containerAppName
}

// rm05 Implementation §3 (D1/D3/D4/D5) — the auth config itself.
resource easyAuthConfig 'Microsoft.App/containerApps/authConfigs@2024-03-01' = {
  parent: ratingEngineApp
  name: 'current'
  properties: {
    platform: {
      enabled: true
    }
    globalValidation: {
      // rm05-spec Implementation §3 also names `requireAuthentication:
      // true`, but that property belongs to App Service's Easy Auth
      // GlobalValidation schema, not Container Apps' — the Container Apps
      // authConfigs API (checked against 2023-05-01 and 2024-03-01 type
      // defs) has no such field on this object; `az bicep build` rejects
      // it. `unauthenticatedClientAction: 'RedirectToLoginPage'` already
      // delivers the same intent for Container Apps: any unauthenticated
      // request is redirected to sign-in rather than served (verification
      // item 3), which is the only mechanism this API exposes for it.
      unauthenticatedClientAction: 'RedirectToLoginPage'
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: ratingEngineClientId
          clientSecretSettingName: 'rating-engine-client-secret'
          openIdIssuer: '${environment().authentication.loginEndpoint}${entraTenantId}/v2.0'
        }
        validation: {
          allowedAudiences: [
            ratingEngineAppIdUri
          ]
        }
      }
    }
    // D9 — no /api/** exclusion path. Easy Auth applies to the whole
    // origin (login/logout routes are Easy Auth's own `/.auth/*` paths,
    // not an application-defined exclusion).
  }
}

// rm05 D7/Implementation §5 — Container App ingress/console logs to the
// shared Log Analytics workspace. Category names per Microsoft.App
// diagnostic settings' documented category groups.
resource containerAppDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01' = {
  name: 'rating-engine-diagnostics'
  scope: ratingEngineApp
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        category: 'ContainerAppConsoleLogs'
        enabled: true
      }
      {
        category: 'ContainerAppSystemLogs'
        enabled: true
      }
    ]
  }
}

resource logAnalyticsWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: logAnalyticsWorkspaceName
}

// rm05 D7 — 2555 days (7 years), archive tier, on both the Entra sign-in
// log table and the Container App log tables. This is the load-bearing
// part of the unit: these logs are the module's substitute for
// core.AUDIT_LOG (architecture §7 #4) and the only record of who
// triggered a reprocess; the workspace's 30-day default silently voids
// that (rm00 rm05). retentionInDays keeps a shorter interactive/query
// window; totalRetentionInDays (inclusive of the archive tier) is the
// 2555-day figure the spec states.
resource signInLogsRetention 'Microsoft.OperationalInsights/workspaces/tables@2022-10-01' = {
  parent: logAnalyticsWorkspace
  name: 'SigninLogs'
  properties: {
    retentionInDays: 90
    totalRetentionInDays: 2555
  }
}

resource containerAppConsoleLogsRetention 'Microsoft.OperationalInsights/workspaces/tables@2022-10-01' = {
  parent: logAnalyticsWorkspace
  name: 'ContainerAppConsoleLogs'
  properties: {
    retentionInDays: 90
    totalRetentionInDays: 2555
  }
}

resource containerAppSystemLogsRetention 'Microsoft.OperationalInsights/workspaces/tables@2022-10-01' = {
  parent: logAnalyticsWorkspace
  name: 'ContainerAppSystemLogs'
  properties: {
    retentionInDays: 90
    totalRetentionInDays: 2555
  }
}

@description('Documents the exact corporate CIDR ranges this deployment applied — a record, not a re-used value (the ingress module receives the same param independently from main.bicep).')
output appliedCorporateIpAllowList array = corporateIpAllowList
output easyAuthConfigId string = easyAuthConfig.id
