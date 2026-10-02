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

// Consumption-plan pairs keep a 1:2 vCPU:GiB ratio (0.25/0.5Gi … 4/8Gi).
// Defaults match ACA's implicit sizing; environments override in *.bicepparam.
param cpu string = '0.5'
param memory string = '1Gi'

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

// bm34 — the distribution target set the app launches and accepts
// (BILLRUN_DISTRIBUTION_TARGETS): a comma-separated list of known targets
// (loopback|sftp). It gates the trigger payload's targets,
// isLaunchedDistributionIdentity, and the mandatory-target completion scaling.
// main.bicep DERIVES this from the single `enableSftpDistribution` knob it also
// passes to the engine module ('sftp' when on, 'loopback' when off), so the app
// and engine can never split-brain — the app never launches/accepts `loopback`
// while the engine delivers over SFTP (which would 409 every real outcome).
param distributionTargets string = 'loopback'

// APP-05 — the outbound bill-run workflow engine (Kestra). HTTPS base URL incl.
// Kestra's `/api/v1/main` REST prefix, derived in main.bicep from the engine's
// ingress FQDN. Empty (the default) omits the engine env vars entirely, so
// lib/config.ts sees BILLRUN_ENGINE_URL/AUTH as absent and engine-registry.ts
// selects the STUB client (no live engine). Non-empty wires all three engine
// vars, and lib/config's superRefine requires URL+AUTH together — so the two KV
// secrets below MUST exist whenever this is set, or the revision fails to start.
@description('APP-05 — HTTPS base URL of the bill-run Kestra engine (incl. /api/v1/main). Empty = stub client. When set, requires the billrun-engine-auth + billrun-app-token Key Vault secrets.')
param billRunEngineUrl string = ''

// bm19/bm34 — the invoice/report artifact store (services/billing/blob-store.ts,
// container `invoices`). When true the app gets BILLRUN_BLOB_CONNECTION_STRING (a
// KV secret ref), the SAME account the distributor engine downloads from, so the
// app-writes / engine-reads loop shares one store. Dev uses the connection-string
// path (auto-creates the container); prod would instead set BILLRUN_BLOB_ACCOUNT_URL
// + Managed Identity — lib/config requires EXACTLY ONE of the two, so this wires
// only the connection-string variant. Default false: no blob env, no secret ref.
@description('bm19/bm34 — wire BILLRUN_BLOB_CONNECTION_STRING (from the billrun-blob-connection-string KV secret) for invoice artifact storage + distribution. Default false.')
param enableBlobArtifacts bool = false

// The client secret is only referenced when SSO is configured: a Key Vault
// reference to a secret that doesn't exist fails the whole revision, and
// lib/config treats all three SSO vars as optional.
var ssoEnabled = !empty(microsoftClientId)

// APP-05 — same fail-safe pattern as ssoEnabled: only reference the engine's Key
// Vault secrets (and emit the env vars) when a URL is supplied, so an engine-less
// environment never fails resolving a secret that isn't provisioned.
var engineWired = !empty(billRunEngineUrl)

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
      secrets: concat(
        [
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
        ],
        ssoEnabled
          ? [
              {
                name: 'microsoft-client-secret'
                keyVaultUrl: '${keyVaultUri}secrets/microsoft-client-secret'
                identity: appManagedIdentityId
              }
            ]
          : [],
        engineWired
          ? [
              // APP-05 — Basic-Auth credential (`<username>:<password>`) the app
              // presents to the engine; engine-client.ts base64-encodes the whole
              // string. Its username half MUST equal the engine's
              // KESTRA_SERVER_BASIC_AUTH_USERNAME (workflow-engine-container-app.bicep's
              // coupled-identity note) and its password the kestra-basic-auth-password.
              {
                name: 'billrun-engine-auth'
                keyVaultUrl: '${keyVaultUri}secrets/billrun-engine-auth'
                identity: appManagedIdentityId
              }
              // bm04 — the plain M2M bearer the app VALIDATES on inbound engine
              // callbacks (`app/api/billrun/*`). Must equal the base64-DECODED value
              // of the engine's billrun-app-token-b64 secret.
              {
                name: 'billrun-app-token'
                keyVaultUrl: '${keyVaultUri}secrets/billrun-app-token'
                identity: appManagedIdentityId
              }
            ]
          : [],
        enableBlobArtifacts
          ? [
              // bm19/bm34 — plain account connection string for the invoice/report
              // artifact store (the engine reads the base64 twin of this value).
              {
                name: 'billrun-blob-connection-string'
                keyVaultUrl: '${keyVaultUri}secrets/billrun-blob-connection-string'
                identity: appManagedIdentityId
              }
            ]
          : []
      )
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
              { name: 'BETTER_AUTH_URL', value: appBaseUrl }
              { name: 'APP_URL', value: appBaseUrl }
              { name: 'NEXT_PUBLIC_APP_URL', value: appBaseUrl }
              { name: 'APP_TIMEZONE', value: appTimezone }
              { name: 'BILLRUN_DISTRIBUTION_TARGETS', value: distributionTargets }
            ],
            // Emitted only when supplied — see the param note above.
            ssoEnabled
              ? [
                  { name: 'MICROSOFT_CLIENT_ID', value: microsoftClientId }
                  { name: 'MICROSOFT_CLIENT_SECRET', secretRef: 'microsoft-client-secret' }
                ]
              : [],
            empty(entraTenantId)
              ? []
              : [{ name: 'ENTRA_TENANT_ID', value: entraTenantId }],
            // APP-05 — the outbound engine connection. URL is a plain value;
            // AUTH (Basic) + APP_TOKEN (inbound bearer) are Key Vault secretRefs.
            // BILLRUN_ENGINE_NAMESPACE is left to lib/config's `billrun` default.
            engineWired
              ? [
                  { name: 'BILLRUN_ENGINE_URL', value: billRunEngineUrl }
                  { name: 'BILLRUN_ENGINE_AUTH', secretRef: 'billrun-engine-auth' }
                  { name: 'BILLRUN_APP_TOKEN', secretRef: 'billrun-app-token' }
                ]
              : [],
            // bm19/bm34 — invoice/report artifact store connection string.
            enableBlobArtifacts
              ? [
                  { name: 'BILLRUN_BLOB_CONNECTION_STRING', secretRef: 'billrun-blob-connection-string' }
                ]
              : []
          )
          resources: {
            cpu: json(cpu)
            memory: memory
          }
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
