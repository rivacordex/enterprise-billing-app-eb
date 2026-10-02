using '../main.bicep'

// um30-spec §"3. Infrastructure as Code (Bicep)" — no secrets in param files.
// All real per-environment Azure identifiers are read from environment variables
// at deploy time (set from the `um30-infra` variable group), keeping this file
// publish-safe. Required vars: POSTGRES_SERVER_NAME, PIPELINE_SP_ID.
// Optional (VNet integration): ACA_SUBNET_ID, ACA_SPOKE_VNET_ID, ACA_HUB_VNET_ID.
// Optional (Entra SSO): ENTRA_TENANT_ID, MICROSOFT_CLIENT_ID — unset disables SSO
// wiring, so set them on EVERY Phase 2 deploy once SSO is enabled.
// Two-pass deploy: ACA_DEFAULT_DOMAIN is empty on pass 1 (ACA env created, domain
// captured from outputs) and set to that domain on pass 2 (DNS zone created).
param postgresServerName = readEnvironmentVariable('POSTGRES_SERVER_NAME')
param pipelineServicePrincipalId = readEnvironmentVariable('PIPELINE_SP_ID')
param entraTenantId = readEnvironmentVariable('ENTRA_TENANT_ID', '')
param microsoftClientId = readEnvironmentVariable('MICROSOFT_CLIENT_ID', '')
param environmentName = 'dev'
// All networking (VNet, Postgres, VPN GW) is in australiaeast — ACA must match
// or VNet injection fails ("VNET is deployed to X, must be deployed to Y").
// The RG <resource-group> is in eastus so `resourceGroup().location` is wrong here.
param location = 'australiaeast'
param minReplicas = 2
param maxReplicas = 3
param appCpu = '2.0'
param appMemory = '4Gi'
param workflowEngineCpu = '2.0'
param workflowEngineMemory = '4Gi'
param appTimezone = 'Asia/Kuala_Lumpur'

// VNet integration — private ACA environment (no public endpoint; VPN-only access).
// Supplied at deploy time from the `um30-infra` variable group. All three must be
// non-empty together for the private DNS zone and VNet links to be created.
// Leave the vars unset (empty string) to deploy a public ACA environment instead.
param acaSubnetId = readEnvironmentVariable('ACA_SUBNET_ID', '')
param acaSpokeVnetId = readEnvironmentVariable('ACA_SPOKE_VNET_ID', '')
param acaHubVnetId = readEnvironmentVariable('ACA_HUB_VNET_ID', '')
// Pass 1: leave ACA_DEFAULT_DOMAIN unset (empty) — ACA env is created and the
// acaEnvironmentDefaultDomain output captures its domain. Pass 2: set
// ACA_DEFAULT_DOMAIN to that value to deploy the DNS zone + records + VNet links.
param acaDefaultDomain = readEnvironmentVariable('ACA_DEFAULT_DOMAIN', '')

// Phase-1 bootstrap: deploy ACR + KV + ACA environment only.
// Flip deployWorkloads=true (and deployWorkflowEngine=true for Kestra) AFTER:
//   1. Container images pushed to ACR (enterprise-billing-app:bootstrap, workflow-engine:bootstrap)
//   2. Key Vault secrets seeded (pg-connection-string-app, better-auth-secret, runtime DB passwords)
// Pass as --parameters overrides rather than changing this committed value so a
// pipeline can drive the progression without a committed state change.
param deployWorkloads = false
// wfm01 §4b — non-prod is collapsed (one workflow-engine instance, both namespaces).
param topology = 'collapsed'
// bm19/bm34 — wire the invoice artifact store (app writes / distributor reads) on
// dev. Requires the billrun-blob-connection-string + -b64 Key Vault secrets.
param enableBlobArtifacts = true
