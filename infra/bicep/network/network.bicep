// ─────────────────────────────────────────────────────────────────────────────
// Hub-spoke network FOUNDATION for the enterprise billing app.
//
// Deploys (all cheap, safe to leave up 24/7):
//   • Hub VNet          — the "Private Network" (/24). Holds the GatewaySubnet
//                         reserved for the P2S VPN Gateway.
//   • Billing spoke VNet — the "Billing Network" (/26), peered INTO the hub so
//                         it sits "within" the private network. Holds the future
//                         ACA + Postgres subnets, pre-shaped with the right
//                         service delegations and NSGs.
//   • NSGs              — encode "VPN users may reach 443 (app/Kestra) and 5432
//                         (Postgres)"; deny inbound Internet.
//   • Peering           — bidirectional hub ⇄ spoke.
//
// The VPN GATEWAY is deliberately NOT here — it is a separate, independently
// deployable template (vpn-gateway.bicep) so it can be created on demand and
// DELETED when idle to avoid the hourly VpnGw1 charge (it has no stop state).
// See README.md.
//
// NOT included yet (parked): the Postgres Flexible Server and the Container
// Apps environment/apps. Their subnets exist here, delegated and NSG-guarded,
// ready for the workloads to drop into later.
// ─────────────────────────────────────────────────────────────────────────────

targetScope = 'resourceGroup'

@allowed(['dev', 'staging', 'prod'])
param environmentName string
param location string = resourceGroup().location

@description('Hub ("Private Network") VNet address space — /24, 256 addresses.')
param hubAddressPrefix string = '10.10.0.0/24'

@description('Hub GatewaySubnet prefix — reserved for the P2S VPN Gateway (vpn-gateway.bicep). Name is fixed by Azure ("GatewaySubnet"); do not attach an NSG or delegation to it.')
param gatewaySubnetPrefix string = '10.10.0.0/27'

@description('Billing ("spoke") VNet address space — /26, 64 addresses. Must NOT overlap the hub.')
param spokeAddressPrefix string = '10.20.0.0/26'

@description('ACA subnet — delegated to Microsoft.App/environments. /27 is the minimum for a workload-profiles Container Apps environment (a Consumption-only env would need /23).')
param acaSubnetPrefix string = '10.20.0.0/27'

@description('Postgres Flexible Server subnet — delegated to Microsoft.DBforPostgreSQL/flexibleServers. Dedicated; nothing else may share it.')
param postgresSubnetPrefix string = '10.20.0.32/28'

@description('P2S VPN client address pool — the addresses handed to VPN clients. Must NOT overlap any VNet. NSGs below reference it as the "VPN users" source.')
param vpnClientAddressPool string = '172.16.0.0/24'

@description('Set TRUE only AFTER the VPN Gateway (vpn-gateway.bicep) has been deployed, then re-deploy THIS template. It flips the spoke-to-hub peering to use the hub gateway (gateway transit) so P2S clients can route into the spoke. Set back to FALSE before deleting the gateway. See README.md "VPN Gateway - day-to-day operations".')
param hubGatewayDeployed bool = false

var namePrefix = 'ebill-${environmentName}'
var hubVnetName = '${namePrefix}-hub-vnet'
var spokeVnetName = '${namePrefix}-billing-vnet'

// ── NSGs ─────────────────────────────────────────────────────────────────────
// Kept intentionally minimal. The default NSG rules already allow intra-VNet
// and Azure Load Balancer inbound and deny Internet inbound; these add the
// explicit "VPN client pool may reach the service port" allowances that encode
// the requirement, plus a belt-and-braces explicit Internet-inbound deny.
//
// NOTE: when the ACA environment is added later, Azure Container Apps has its
// own set of REQUIRED NSG rules for a locked-down subnet — revisit the ACA NSG
// at that point. Nothing here blocks ACA's platform traffic today.

resource acaNsg 'Microsoft.Network/networkSecurityGroups@2023-09-01' = {
  name: '${namePrefix}-aca-nsg'
  location: location
  properties: {
    securityRules: [
      {
        name: 'Allow-VPN-clients-HTTPS'
        properties: {
          description: 'VPN users -> App FE / Kestra FE (ACA internal ingress terminates on 443 per app hostname).'
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: vpnClientAddressPool
          sourcePortRange: '*'
          destinationAddressPrefix: acaSubnetPrefix
          destinationPortRange: '443'
        }
      }
      {
        name: 'Allow-Intra-VNet'
        properties: {
          description: 'Allow traffic within the VNet and from the peered hub (VirtualNetwork includes peered ranges).'
          priority: 110
          direction: 'Inbound'
          access: 'Allow'
          protocol: '*'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: 'VirtualNetwork'
          destinationPortRange: '*'
        }
      }
      {
        name: 'Deny-Internet-Inbound'
        properties: {
          description: 'Explicit deny of any inbound sourced from the public Internet.'
          priority: 4096
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: 'Internet'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

resource postgresNsg 'Microsoft.Network/networkSecurityGroups@2023-09-01' = {
  name: '${namePrefix}-postgres-nsg'
  location: location
  properties: {
    securityRules: [
      {
        name: 'Allow-VPN-clients-Postgres'
        properties: {
          description: 'VPN users -> Postgres Flexible Server on 5432 (e.g. psql / a DB client over the VPN).'
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: vpnClientAddressPool
          sourcePortRange: '*'
          destinationAddressPrefix: postgresSubnetPrefix
          destinationPortRange: '5432'
        }
      }
      {
        name: 'Allow-ACA-subnet-Postgres'
        properties: {
          description: 'The app + Kestra (ACA subnet) -> Postgres on 5432.'
          priority: 110
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: acaSubnetPrefix
          sourcePortRange: '*'
          destinationAddressPrefix: postgresSubnetPrefix
          destinationPortRange: '5432'
        }
      }
      {
        name: 'Deny-Internet-Inbound'
        properties: {
          description: 'Explicit deny of any inbound sourced from the public Internet.'
          priority: 4096
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: 'Internet'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

// ── Hub VNet (Private Network) ───────────────────────────────────────────────
// Only the GatewaySubnet is defined now; the rest of the /24 is spare headroom
// for a future bastion / management / jumpbox subnet.
resource hubVnet 'Microsoft.Network/virtualNetworks@2023-09-01' = {
  name: hubVnetName
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        hubAddressPrefix
      ]
    }
    subnets: [
      {
        // Name MUST be exactly "GatewaySubnet" — Azure requires it for a VPN
        // Gateway. No NSG and no delegation here (both are unsupported /
        // discouraged on the gateway subnet).
        name: 'GatewaySubnet'
        properties: {
          addressPrefix: gatewaySubnetPrefix
        }
      }
    ]
  }
}

// ── Billing spoke VNet ───────────────────────────────────────────────────────
resource spokeVnet 'Microsoft.Network/virtualNetworks@2023-09-01' = {
  name: spokeVnetName
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        spokeAddressPrefix
      ]
    }
    subnets: [
      {
        name: 'snet-billing-aca'
        properties: {
          addressPrefix: acaSubnetPrefix
          networkSecurityGroup: {
            id: acaNsg.id
          }
          delegations: [
            {
              name: 'aca-delegation'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        name: 'snet-billing-postgres'
        properties: {
          addressPrefix: postgresSubnetPrefix
          networkSecurityGroup: {
            id: postgresNsg.id
          }
          delegations: [
            {
              name: 'postgres-delegation'
              properties: {
                serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers'
              }
            }
          ]
        }
      }
    ]
  }
}

// ── Peering ──────────────────────────────────────────────────────────────────
// Hub → Spoke: offers the hub's gateway to the spoke (allowGatewayTransit). This
// is harmless before a gateway exists — it only takes effect once one does.
resource hubToSpoke 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2023-09-01' = {
  parent: hubVnet
  name: 'hub-to-billing'
  properties: {
    remoteVirtualNetwork: {
      id: spokeVnet.id
    }
    allowVirtualNetworkAccess: true
    allowForwardedTraffic: true
    allowGatewayTransit: true
    useRemoteGateways: false
  }
}

// Spoke → Hub: uses the hub's gateway (gateway transit) so P2S clients can reach
// the spoke and the spoke has a return route to the client pool. `useRemoteGateways`
// CANNOT be true until the hub actually has a gateway — hence the toggle: leave
// false, deploy the gateway, then re-deploy with hubGatewayDeployed=true.
resource spokeToHub 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2023-09-01' = {
  parent: spokeVnet
  name: 'billing-to-hub'
  properties: {
    remoteVirtualNetwork: {
      id: hubVnet.id
    }
    allowVirtualNetworkAccess: true
    allowForwardedTraffic: true
    allowGatewayTransit: false
    useRemoteGateways: hubGatewayDeployed
  }
}

// ── Outputs (consumed later by the Postgres + ACA templates) ─────────────────
output hubVnetName string = hubVnet.name
output hubVnetId string = hubVnet.id
output spokeVnetName string = spokeVnet.name
output spokeVnetId string = spokeVnet.id
output gatewaySubnetId string = '${hubVnet.id}/subnets/GatewaySubnet'
output acaSubnetId string = '${spokeVnet.id}/subnets/snet-billing-aca'
output postgresSubnetId string = '${spokeVnet.id}/subnets/snet-billing-postgres'
output vpnClientAddressPool string = vpnClientAddressPool
