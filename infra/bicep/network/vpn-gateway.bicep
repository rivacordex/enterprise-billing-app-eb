// ─────────────────────────────────────────────────────────────────────────────
// Point-to-Site (P2S) VPN GATEWAY for the hub VNet.
//
// SEPARATE from network.bicep on purpose: a VPN Gateway has NO stop/deallocate
// state — it bills per hour for as long as it exists (VpnGw1AZ ≈ ~$154/mo). The
// only cost lever is DELETE + RECREATE on demand. Keeping it in its own template
// makes that a one-command operation. See README.md → "VPN Gateway — day-to-day
// operations".
//
// Depends on network.bicep having already created the hub VNet with its
// GatewaySubnet (referenced `existing` below).
//
// Provisioning a VPN Gateway takes ~30–45 minutes.
// ─────────────────────────────────────────────────────────────────────────────

targetScope = 'resourceGroup'

@allowed(['dev', 'staging', 'prod'])
param environmentName string
param location string = resourceGroup().location

@description('Name of the EXISTING hub VNet created by network.bicep. Must already contain a subnet named "GatewaySubnet".')
param hubVnetName string = 'ebill-${environmentName}-hub-vnet'

@description('P2S VPN client address pool. MUST match network.bicep\'s vpnClientAddressPool and not overlap any VNet.')
param vpnClientAddressPool string = '172.16.0.0/24'

@allowed([
  'VpnGw1AZ'
  'VpnGw2AZ'
  'VpnGw3AZ'
])
@description('Gateway SKU. VpnGw1AZ (~$154/mo) is the baseline zone-redundant SKU that supports OpenVPN/IKEv2 P2S with the Azure VPN Client. Non-AZ SKUs (VpnGw1 etc.) are no longer accepted by Azure as of 2025.')
param gatewaySku string = 'VpnGw1AZ'

@description('Base64 PUBLIC cert data of your P2S ROOT certificate. This is a public key, NOT a secret — but it is left EMPTY by default so no cert material is committed. Required at deployment time: supply it via the documented parameter override (`--parameters rootCertData=$rootPublic`, README), never committed to the param file.')
param rootCertData string = ''

@description('Name for the uploaded root certificate.')
param rootCertName string = 'ebill-p2s-root'

var namePrefix = 'ebill-${environmentName}'

resource hubVnet 'Microsoft.Network/virtualNetworks@2023-09-01' existing = {
  name: hubVnetName
}

// Standard, static public IP — required for VpnGw* SKUs. Kept as its own
// resource so a gateway DELETE (bring-down) can leave the IP in place; the next
// bring-up re-uses the same name (and therefore the same address). Cost is ~a
// few $/mo — negligible next to the gateway.
resource gatewayPublicIp 'Microsoft.Network/publicIPAddresses@2023-09-01' = {
  name: '${namePrefix}-vpngw-pip'
  location: location
  sku: {
    name: 'Standard'
  }
  // AZ SKUs (VpnGw1AZ+) require a zone-redundant public IP.
  zones: ['1', '2', '3']
  properties: {
    publicIPAllocationMethod: 'Static'
  }
}

resource vpnGateway 'Microsoft.Network/virtualNetworkGateways@2023-09-01' = {
  name: '${namePrefix}-vpngw'
  location: location
  properties: {
    gatewayType: 'Vpn'
    vpnType: 'RouteBased'
    sku: {
      name: gatewaySku
      tier: gatewaySku
    }
    activeActive: false
    enableBgp: false
    ipConfigurations: [
      {
        name: 'vnetGatewayConfig'
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          subnet: {
            id: '${hubVnet.id}/subnets/GatewaySubnet'
          }
          publicIPAddress: {
            id: gatewayPublicIp.id
          }
        }
      }
    ]
    // Point-to-Site configuration. Certificate authentication with OpenVPN +
    // IKEv2 tunnels, both of which the Azure VPN Client supports. Root certs are
    // added out-of-band (empty here by default) so no cert data lives in the repo.
    vpnClientConfiguration: {
      vpnClientAddressPool: {
        addressPrefixes: [
          vpnClientAddressPool
        ]
      }
      vpnClientProtocols: [
        'OpenVPN'
        'IkeV2'
      ]
      vpnAuthenticationTypes: [
        'Certificate'
      ]
      vpnClientRootCertificates: empty(rootCertData)
        ? []
        : [
            {
              name: rootCertName
              properties: {
                publicCertData: rootCertData
              }
            }
          ]
    }
  }
}

output vpnGatewayName string = vpnGateway.name
output vpnGatewayPublicIpName string = gatewayPublicIp.name
output vpnGatewayPublicIp string = gatewayPublicIp.properties.ipAddress
