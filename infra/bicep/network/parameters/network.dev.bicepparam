using '../network.bicep'

param environmentName = 'dev'
param location = 'australiaeast'

// ── Address plan (see README.md "Address plan"). Override only if these ranges
// collide with a corporate/on-prem range you must fit within.
param hubAddressPrefix = '10.10.0.0/24' // Hub / Private Network — 256 addresses
param gatewaySubnetPrefix = '10.10.0.0/27' // Reserved for the VPN Gateway
param spokeAddressPrefix = '10.20.0.0/26' // Billing spoke — 64 addresses
param acaSubnetPrefix = '10.20.0.0/27' // ACA (delegated Microsoft.App/environments)
param postgresSubnetPrefix = '10.20.0.32/28' // Postgres (delegated flexibleServers)
param vpnClientAddressPool = '172.16.0.0/24' // P2S client pool — off-VNet range

// Leave FALSE until the VPN Gateway is deployed. Flip to true and re-deploy this
// template to grant P2S clients gateway transit into the spoke. See README.md
// "VPN Gateway — day-to-day operations".
param hubGatewayDeployed = false
