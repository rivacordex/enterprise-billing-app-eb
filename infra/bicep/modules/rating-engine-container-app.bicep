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

@description('true = ingress fully internal to the Container Apps Environment (no external DNS at all); false = disabled (D8 default until rm05).')
param internalIngress bool = false

// rm05-spec D2 — rm05 is the ONE unit that turns on external ingress, and
// only behind Easy Auth + the IP allow-list (D6). rm04 and rm05 must not
// both write this block; this file owns it going forward, gated by this
// param so an rm04-only deploy (enableEasyAuthIngress left false) still
// gets the D8 internal-only/disabled default above.
@description('rm05 D2 — flips ingress from internal-only/disabled (rm04 default) to external, restricted by corporateIpAllowList. Set true only alongside deploying easy-auth.bicep\'s authConfig in the same pass.')
param enableEasyAuthIngress bool = false

@description('rm05 D6 — corporate CIDR ranges allowed through ingress once external. Org-specific, supplied at deploy time, never committed as literals. Enforcement that this is non-empty when enableEasyAuthIngress is true lives in easy-auth.bicep (its own corporateIpAllowList param is required + @minLength(1)) — deployed in the same pass, so an empty list fails the overall deployment rather than silently exposing the UI (rm05 verification item 14).')
param corporateIpAllowList array = []

param minReplicas int = 1
param maxReplicas int = 1

// Extracted to a var — a for-expression can't sit inline inside a ternary
// property value (BCP disallows it there even though it's allowed as a
// property value directly).
var corporateIpSecurityRestrictions = [
  for (ip, i) in corporateIpAllowList: {
    name: 'corporate-range-${i}'
    action: 'Allow'
    ipAddressRange: ip
  }
]

// Azure Files storage definition at the Container Apps Environment level —
// a sibling resource to the environment, referenced by name in the volume
// mount below (existing environment, referenced not created — D1 shared
// platform footprint).
resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2023-05-01' existing = {
  name: last(split(containerAppsEnvironmentId, '/'))
}

// The rating-engine storage account (rating-engine-storage.bicep). Referenced,
// not created — the implicit dependency on storageAccountName (a storage-module
// output) guarantees it exists before this deploys. The account key is
// resolved inline via listKeys() for the platform-level SMB Files mount ONLY
// (no MI mount option for Files on Container Apps); it is never surfaced to the
// engine as an app-level credential and never crosses a module output.
resource ratingStorageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' existing = {
  name: storageAccountName
}

resource landingFileStorage 'Microsoft.App/managedEnvironments/storages@2023-05-01' = {
  parent: containerAppsEnvironment
  name: 'rating-landing'
  properties: {
    azureFile: {
      accountName: storageAccountName
      accountKey: ratingStorageAccount.listKeys().keys[0].value
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
      secrets: concat(
        [
          // D5 — three of the four credentials as Key Vault secret refs (the
          // fourth, internal-storage, is Managed-Identity-only — see
          // rating-engine-storage.bicep's role assignments, no KV secret here).
          {
            name: 'kestra-basic-auth-password'
            keyVaultUrl: '${keyVaultUri}secrets/kestra-basic-auth-password'
            identity: ratingEngineManagedIdentityId
          }
          {
            // rating-engine/worker/runtime/db.py's `_dsn()` reads
            // SECRET_RATING_RUNTIME_PASSWORD as a bare password and builds
            // the DSN itself from separate RATING_DB_HOST/PORT/NAME/USER env
            // vars (never a full connection string) — so this KV secret
            // holds the dedicated rating_runtime password (the value set by
            // the `ALTER ROLE rating_runtime WITH PASSWORD` step in
            // infra/docs/db-role-verification.md), NOT a full connection
            // string. Named to match that, unlike the `pg-connection-string-app`/
            // `-migrate` secrets which genuinely are full DATABASE_URL values.
            name: 'rating-runtime-db-password'
            keyVaultUrl: '${keyVaultUri}secrets/rating-runtime-db-password'
            identity: ratingEngineManagedIdentityId
          }
          {
            // kestra.yml sets `datasources.postgres.password` from
            // KESTRA_DATASOURCES_POSTGRES_PASSWORD — a bare password, since the
            // URL and username are provided separately below. So this KV secret
            // holds the dedicated kestra_engine password (the value set by the
            // `ALTER ROLE kestra_engine WITH PASSWORD` step in
            // infra/docs/db-role-verification.md), NOT a full connection string.
            name: 'kestra-engine-db-password'
            keyVaultUrl: '${keyVaultUri}secrets/kestra-engine-db-password'
            identity: ratingEngineManagedIdentityId
          }
          {
            // rm06 — backs ran-usage-rating.yaml's Webhook trigger
            // `key: {{ secret('RATING_USAGE_WEBHOOK_KEY') }}` (the REQUIRED,
            // URL-embedded webhook auth token, code-standards §3.8). Unlike the
            // password secrets above (read RAW by the worker's db.py via
            // os.environ), this is a genuine Kestra `secret()` lookup, so the
            // Key Vault VALUE MUST BE BASE64-ENCODED — Kestra OSS's env-var
            // secret backend base64-decodes `SECRET_<NAME>` (Kestra docs,
            // "Environment variables as secrets (OSS)"). Confirm the backend
            // behaviour against the pinned release at the D0 spike.
            name: 'rating-usage-webhook-key'
            keyVaultUrl: '${keyVaultUri}secrets/rating-usage-webhook-key'
            identity: ratingEngineManagedIdentityId
          }
        ],
        enableEasyAuthIngress
          ? [
              // rm05 D8 — the rating-engine Entra registration's client
              // secret; easy-auth.bicep's authConfig points
              // clientSecretSettingName at this secret's NAME (not the KV
              // reference directly, matching the app's established pattern).
              {
                name: 'rating-engine-client-secret'
                keyVaultUrl: '${keyVaultUri}secrets/rating-engine-client-secret'
                identity: ratingEngineManagedIdentityId
              }
            ]
          : []
      )
      // No `traffic` block on either ingress branch — activeRevisionsMode
      // 'Single' routes 100% to the single active revision implicitly;
      // specifying weights is only valid in 'Multiple' mode.
      ingress: enableEasyAuthIngress
        ? {
            // rm05 D2/D6/Implementation §4 — the only place external ingress
            // is enabled, and only with a populated corporate allow-list
            // (default-deny once any Allow rule is present).
            external: true
            targetPort: 8080
            ipSecurityRestrictions: corporateIpSecurityRestrictions
          }
        : (internalIngress
            ? {
                external: false
                targetPort: 8080
              }
            : null)
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
            { name: 'KESTRA_DATASOURCES_POSTGRES_PASSWORD', secretRef: 'kestra-engine-db-password' }

            // D7 — storage.type: azure, internal storage → the
            // kestra-internal Blob container (NOT the container filesystem,
            // code-standards §3.4). Auth is Managed Identity
            // (DefaultAzureCredential) per D5's stated preference — CONFIRM
            // the pinned Kestra Azure Blob plugin version actually supports
            // MI auth during the D0 spike; if it does not, this falls back
            // to a SAS/connection-string KV secret and D5's credential count
            // changes from three KV secrets to four.
            //
            // ACCOUNT_NAME is deliberately named RATING_ENGINE_AZURE_*, not
            // KESTRA_STORAGE_AZURE_* (confirmed live, 2026-09-01, local dev):
            // Micronaut auto-exposes EVERY container env var as a property by
            // lowercasing + splitting on `_`, so KESTRA_STORAGE_AZURE_ACCOUNT_NAME
            // also (independently of kestra.yml's ${...} substitution) creates
            // kestra.storage.azure.account.name — a bogus NESTED "account" map
            // sibling to the real `sharedKeyAccountName` field, which Kestra's
            // plugin-config Jackson binding then rejects as an unrecognized
            // property. ENDPOINT/CONTAINER are single-word suffixes (no
            // internal `_`) so they don't collide and keep their names.
            { name: 'KESTRA_STORAGE_TYPE', value: 'azure' }
            { name: 'RATING_ENGINE_AZURE_ACCOUNT_NAME', value: storageAccountName }
            { name: 'KESTRA_STORAGE_AZURE_CONTAINER', value: kestraInternalContainerName }
            { name: 'KESTRA_STORAGE_AZURE_ENDPOINT', value: 'https://${storageAccountName}.blob.${environment().suffixes.storage}' }

            // D7 — Basic Auth from the one shared credential; D5's Kestra
            // Basic Auth entry. Username is non-secret (fixed operator
            // login name); only the password is a KV secret.
            //
            // CONFIRMED against the pinned engine (2026-09-02, live local
            // login attempt — see rating-engine/dev/.env.example): Kestra
            // 1.3.35's BasicAuthService validates this pair at startup and
            // silently rejects the WHOLE configuration (no active credential
            // at all, every login 401s) if the username is not a valid email
            // address or the password fails an 8-char/upper/lower/digit
            // policy — recorded in the `kestra` DB's `settings` table under
            // `kestra.server.authentication-configuration-error` when it
            // happens. The bare `rating-ops` literal here fails the email
            // check. **The `kestra-basic-auth-password` Key Vault secret must
            // also satisfy the password policy** — that value is not visible
            // or settable from this file; confirm it separately before the
            // next deploy that exercises this.
            { name: 'KESTRA_SERVER_BASIC_AUTH_USERNAME', value: 'rating-ops@example.invalid' }
            { name: 'KESTRA_SERVER_BASIC_AUTH_PASSWORD', secretRef: 'kestra-basic-auth-password' }

            // D7 — default namespace `rating`.
            { name: 'KESTRA_SERVER_DEFAULT_NAMESPACE', value: 'rating' }

            // code-standards §3.8 — the worker's db.py reads this bare
            // password directly from os.environ (NOT via Kestra's `secret()`),
            // so the value is stored/passed plain. The `SECRET_` prefix is a
            // naming convention only here; it is not base64-decoded because no
            // flow resolves it through `{{ secret('RATING_RUNTIME_PASSWORD') }}`.
            { name: 'SECRET_RATING_RUNTIME_PASSWORD', secretRef: 'rating-runtime-db-password' }

            // rm06 §3.8 — ran-usage-rating.yaml's Webhook trigger resolves its
            // required `key` via `{{ secret('RATING_USAGE_WEBHOOK_KEY') }}`.
            // This IS a real Kestra `secret()` call, so Kestra's OSS env secret
            // backend base64-DECODES this value — the KV secret must hold the
            // BASE64-encoded key (see the rating-usage-webhook-key secret above).
            { name: 'SECRET_RATING_USAGE_WEBHOOK_KEY', secretRef: 'rating-usage-webhook-key' }
          ]
          volumeMounts: [
            {
              volumeName: 'landing'
              mountPath: '/data/landing'
            }
          ]
          // Kestra serves /health on its Micronaut MANAGEMENT port (8081),
          // NOT the webserver/UI port (8080) — probing 8080/health returns
          // 404 and the revision never becomes Healthy. The management port
          // is unauthenticated by default, so Basic Auth (on 8080) does not
          // block these probes. D0 spike: confirm 8081 against the pinned
          // Kestra release, and on Kestra >= 0.22 consider the split
          // /health/liveness + /health/readiness endpoints so a transient DB
          // outage fails readiness without triggering a liveness restart.
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/health', port: 8081 }
              initialDelaySeconds: 30
              periodSeconds: 10
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: { path: '/health', port: 8081 }
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
