// um30-spec §"3. Infrastructure as Code (Bicep)" — modules/container-app.bicep.
// Revision mode `Multiple` (blue-green + instant rollback), min 2 replicas
// (zone-spread HA), Key Vault secret references for every secret env var,
// user-assigned Managed Identity used both to pull from ACR and to fetch
// Key Vault secrets. The Entra secret is consumed as `MICROSOFT_CLIENT_SECRET`
// (deviation, codebase wins — `lib/config.ts` has read `MICROSOFT_CLIENT_SECRET`
// since um10; the spec's literal `ENTRA_CLIENT_SECRET` is not an env var the
// app reads, so setting it would silently leave SSO unconfigured).
param location string
param containerAppName string
param containerAppsEnvironmentId string
param acrLoginServer string
param keyVaultUri string
param appManagedIdentityId string
param imageName string
// Public base URL of this app. Required at runtime by lib/config.ts
// (BETTER_AUTH_URL has no default) and used for auth redirects (APP_URL /
// NEXT_PUBLIC_APP_URL). Derived in main.bicep from the Container Apps
// environment's default domain.
param appBaseUrl string
param minReplicas int = 2
param maxReplicas int = 5

// Non-secret Microsoft SSO identifiers read by lib/config.ts. The tenant
// (directory) ID and client (application) ID are PUBLIC identifiers — not
// credentials — so they are plain `value` env vars, not Key Vault secretRefs
// (the only SSO secret is `microsoft-client-secret`, above). They are still
// injected as DEPLOY-TIME PARAMETERS from the `um30-infra` pipeline variable
// group rather than hardcoded in the committed `*.bicepparam`, so the concrete
// tenant/client IDs never enter source control. Empty (the default, e.g. an
// environment without an Entra app registration) omits the env vars entirely,
// so lib/config sees them as absent (`?? null` → SSO stays disabled) rather
// than present-but-empty.
param entraTenantId string = ''
param microsoftClientId string = ''

// Business timezone (IANA name) read by lib/config.ts as APP_TIMEZONE (um29-spec).
// Non-secret and environment-specific, so — unlike the SSO IDs above — it is a
// plain `value` env var supplied from the committed `*.bicepparam`. The caller
// (main.bicep) constrains it to lib/locale.ts SUPPORTED_TIMEZONES via @allowed;
// the app additionally fails fast at boot on an unsupported value. Defaults to
// UTC, matching the app's DEFAULT_TIMEZONE (behavior-preserving).
param appTimezone string = 'UTC'

resource containerApp 'Microsoft.App/containerApps@2023-05-01' = {
  name: containerAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${appManagedIdentityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppsEnvironmentId
    configuration: {
      activeRevisionsMode: 'Multiple'
      registries: [
        {
          server: acrLoginServer
          identity: appManagedIdentityId
        }
      ]
      secrets: [
        {
          name: 'pg-connection-string-app'
          keyVaultUrl: '${keyVaultUri}secrets/pg-connection-string-app'
          identity: appManagedIdentityId
        }
        {
          name: 'better-auth-secret'
          keyVaultUrl: '${keyVaultUri}secrets/better-auth-secret'
          identity: appManagedIdentityId
        }
        {
          name: 'microsoft-client-secret'
          keyVaultUrl: '${keyVaultUri}secrets/microsoft-client-secret'
          identity: appManagedIdentityId
        }
      ]
      ingress: {
        external: true
        targetPort: 3000
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
    }
    template: {
      containers: [
        {
          name: 'enterprise-billing-app'
          image: imageName
          env: concat(
            [
              { name: 'DATABASE_URL', secretRef: 'pg-connection-string-app' }
              { name: 'BETTER_AUTH_SECRET', secretRef: 'better-auth-secret' }
              { name: 'MICROSOFT_CLIENT_SECRET', secretRef: 'microsoft-client-secret' }
              { name: 'BETTER_AUTH_URL', value: appBaseUrl }
              { name: 'APP_URL', value: appBaseUrl }
              { name: 'NEXT_PUBLIC_APP_URL', value: appBaseUrl }
              { name: 'APP_TIMEZONE', value: appTimezone }
            ],
            // Emitted only when supplied — see the param note above.
            empty(microsoftClientId)
              ? []
              : [{ name: 'MICROSOFT_CLIENT_ID', value: microsoftClientId }],
            empty(entraTenantId)
              ? []
              : [{ name: 'ENTRA_TENANT_ID', value: entraTenantId }]
          )
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/api/health'
                port: 3000
              }
              initialDelaySeconds: 10
              periodSeconds: 5
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/api/health'
                port: 3000
              }
              periodSeconds: 5
              successThreshold: 2
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'http-concurrency-scale'
            http: {
              metadata: {
                concurrentRequests: '50'
              }
            }
          }
        ]
      }
    }
  }
}

output fqdn string = containerApp.properties.configuration.ingress.fqdn
