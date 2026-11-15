targetScope = 'resourceGroup'

param privateDnsZoneName string
param virtualNetworkId string
param linkName string

resource zone 'Microsoft.Network/privateDnsZones@2020-06-01' existing = { name: privateDnsZoneName }

resource link 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: zone
  name: linkName
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: virtualNetworkId }
  }
}

output linkId string = link.id
