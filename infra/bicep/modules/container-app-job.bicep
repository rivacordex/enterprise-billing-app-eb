// um30-spec §"3. Infrastructure as Code (Bicep)" — modules/container-app-job.bicep.
// Migration job: same image as the app, a separate Managed Identity, and
// the app_migrate connection string (a different Key Vault secret).
// Manual trigger only — invoked by the pipeline's `migrate` stage. Runs the
// codebase's actual migration entrypoint (db/migrate.ts via tsx, the same
// command `npm run db:migrate` wraps) rather than the spec's literal
// `npx drizzle-kit migrate` — deviation, codebase wins, consistent with the
// documented pattern in every other unit's spec deviations.
param location string
param jobName string
param containerAppsEnvironmentId string
param acrLoginServer string
param keyVaultUri string
param migrateManagedIdentityId string
param imageName string

resource migrationJob 'Microsoft.App/jobs@2023-05-01' = {
  name: jobName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${migrateManagedIdentityId}': {}
    }
  }
  properties: {
    environmentId: containerAppsEnvironmentId
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 300
      replicaRetryLimit: 0
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: acrLoginServer
          identity: migrateManagedIdentityId
        }
      ]
      secrets: [
        {
          name: 'pg-connection-string-migrate'
          keyVaultUrl: '${keyVaultUri}secrets/pg-connection-string-migrate'
          identity: migrateManagedIdentityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'db-migrate'
          image: imageName
          command: ['node', '--import', 'tsx', 'db/migrate.ts']
          // lib/config.ts validates the FULL env schema at import time, and
          // db/migrate.ts imports it. The Job never serves auth, so BETTER_AUTH_*
          // are inert placeholders that only satisfy the schema (.min(32) / .url())
          // — the real secret is used by the app revision (deploy stage), never
          // here. Mirrors the Dockerfile builder stage. Without them the Job
          // crashes at import with "Invalid environment configuration".
          // NODE_OPTIONS sets the `react-server` export condition so the
          // `import "server-only"` at the top of lib/config.ts resolves to its
          // no-op instead of throwing under this Job's plain `node ... tsx`
          // command (the Job never serves a client bundle). Without it the
          // import aborts with "This module cannot be imported from a Client
          // Component module." Mirrors the `validate:env` script's flag.
          env: [
            { name: 'DATABASE_URL', secretRef: 'pg-connection-string-migrate' }
            { name: 'BETTER_AUTH_SECRET', value: 'build_time_placeholder_secret_min_32_chars' }
            { name: 'BETTER_AUTH_URL', value: 'http://localhost:3000' }
            { name: 'NODE_OPTIONS', value: '--conditions=react-server' }
          ]
        }
      ]
    }
  }
}

output jobName string = migrationJob.name
