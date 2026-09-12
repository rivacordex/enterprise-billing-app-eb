using '../main.bicep'

// `postgresServerName` and `pipelineServicePrincipalId` are supplied at deploy time
// from the `um30-infra` variable group (see main.bicep), not committed here.
param environmentName = 'prod'
param minReplicas = 2
param maxReplicas = 5
param appTimezone = 'Asia/Kuala_Lumpur'
// wfm01 §4b — collapsed by default; prod MAY switch to 'split-by-module' (two
// engine instances, rating | billrun isolated) — a param + env-template change
// only, no app-code change (engine-registry is by-name).
param topology = 'collapsed'
