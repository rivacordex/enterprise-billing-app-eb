using '../main.bicep'

param environmentName = 'staging'
param postgresServerName = 'ebill-staging-pg'
param pipelineServicePrincipalId = '00000000-0000-0000-0000-000000000000'
param minReplicas = 2
param maxReplicas = 4
