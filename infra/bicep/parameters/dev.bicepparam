using '../main.bicep'

// um30-spec §"3. Infrastructure as Code (Bicep)" — no secrets in param files.
// `postgresServerName` and `pipelineServicePrincipalId` are real per-environment
// Azure identifiers; they are NOT committed here but supplied at deploy time from
// the `um30-infra` variable group (see main.bicep), keeping this file publish-safe.
param environmentName = 'dev'
param minReplicas = 2
param maxReplicas = 3
param appTimezone = 'Asia/Kuala_Lumpur'
// Phase-2: infra (Key Vault + secrets, ACR + image) is in place, so deploy
// the Container App + migrate Job that consume them.
param deployWorkloads = true
