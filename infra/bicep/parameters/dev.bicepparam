using '../main.bicep'

// um30-spec §"3. Infrastructure as Code (Bicep)" — no secrets in param
// files. `postgresServerName`/`pipelineServicePrincipalId` are real Azure
// resource identifiers, filled in once the dev Flexible Server and Azure
// DevOps service connection exist; left as placeholders here.
param environmentName = 'dev'
param postgresServerName = 'ebill-dev-pg'
param pipelineServicePrincipalId = '00000000-0000-0000-0000-000000000000'
param minReplicas = 2
param maxReplicas = 3
