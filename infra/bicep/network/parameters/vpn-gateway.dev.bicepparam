using '../vpn-gateway.bicep'

param environmentName = 'dev'
param location = 'australiaeast'

// Must match network.bicep's hub VNet name + client pool.
param hubVnetName = 'ebill-dev-hub-vnet'
param vpnClientAddressPool = '172.16.0.0/24'

// VpnGw1AZ (~$154/mo) — the baseline zone-redundant SKU. Non-AZ SKUs retired by Azure.
param gatewaySku = 'VpnGw1AZ'

// Root cert PUBLIC data NOT committed. Azure now requires it at creation time (cert auth
// cannot be configured post-deploy). Pass via --parameters rootCertData=<value> at deploy.
// Generate via: $rootPublic = [Convert]::ToBase64String($root.Export('Cert'))
// See README.md and infra/docs/environment-operations.md "VPN Gateway → 3a".
param rootCertData = ''
param rootCertName = 'ebill-p2s-root'
