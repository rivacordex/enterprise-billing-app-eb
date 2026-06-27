using '../main.bicep'

// um30-spec §"3. Infrastructure as Code (Bicep)" — no secrets in param
// files. `postgresServerName`/`pipelineServicePrincipalId` are real Azure
// resource identifiers, filled in once the dev Flexible Server and Azure
// DevOps service connection exist; left as placeholders here.
param environmentName = 'dev'
param postgresServerName = 'ebill-dev-pg'
param pipelineServicePrincipalId = '4e6834e0-6b11-42ce-980b-4d014e3b73ba'
param minReplicas = 2
param maxReplicas = 3
// Phase-2: infra (Key Vault + secrets, ACR + image) is in place, so deploy
// the Container App + migrate Job that consume them.
param deployWorkloads = true
