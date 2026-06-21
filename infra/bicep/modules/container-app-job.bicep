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
          env: [
            { name: 'DATABASE_URL', secretRef: 'pg-connection-string-migrate' }
          ]
        }
      ]
    }
  }
}

output jobName string = migrationJob.name
