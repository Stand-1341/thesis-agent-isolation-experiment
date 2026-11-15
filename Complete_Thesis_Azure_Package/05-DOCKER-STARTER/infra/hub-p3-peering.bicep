targetScope = 'resourceGroup'

param hubVnetName string
param spokeVnetResourceId string
param peeringName string

resource hub 'Microsoft.Network/virtualNetworks@2023-09-01' existing = { name: hubVnetName }

resource reciprocal 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2023-09-01' = {
  parent: hub
  name: peeringName
  properties: {
    remoteVirtualNetwork: { id: spokeVnetResourceId }
    allowVirtualNetworkAccess: true
    allowForwardedTraffic: true
    allowGatewayTransit: false
    useRemoteGateways: false
  }
}

output peeringId string = reciprocal.id
