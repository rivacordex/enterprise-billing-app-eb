using '../main.bicep'

// `postgresServerName` and `pipelineServicePrincipalId` are supplied at deploy time
// from the `um30-infra` variable group (see main.bicep), not committed here.
param environmentName = 'staging'
param minReplicas = 2
param maxReplicas = 4
param appTimezone = 'Asia/Kuala_Lumpur'
// wfm01 §4b — non-prod is collapsed (one workflow-engine instance, both namespaces).
param topology = 'collapsed'
