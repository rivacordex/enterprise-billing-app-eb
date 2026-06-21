using '../main.bicep'

param environmentName = 'prod'
param postgresServerName = 'ebill-prod-pg'
param pipelineServicePrincipalId = '00000000-0000-0000-0000-000000000000'
param minReplicas = 2
param maxReplicas = 5
