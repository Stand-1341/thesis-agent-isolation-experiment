// Candidate private Blob path. This does not connect the laptop controller to
// the VNet or prove workload isolation; establish a trusted route and DNS.
param location string = resourceGroup().location
param endpointName string
param virtualNetworkId string
param endpointSubnetId string
@description('Static private IP inside the endpoint subnet, reserved for this Blob endpoint.')
param endpointPrivateIp string
param storageAccountId string

resource dns 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: 'privatelink.blob.${environment().suffixes.storage}'
  location: 'global'
}
resource link 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: dns
  name: '${endpointName}-vnet'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: virtualNetworkId } }
}
resource endpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = {
  name: endpointName
  location: location
  properties: {
    subnet: { id: endpointSubnetId }
    ipConfigurations: [{
      name: 'blob-ip'
      properties: {
        groupId: 'blob'
        memberName: 'blob'
        privateIPAddress: endpointPrivateIp
      }
    }]
    privateLinkServiceConnections: [{
      name: 'blob'
      properties: { privateLinkServiceId: storageAccountId, groupIds: ['blob'] }
    }]
  }
}
resource dnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-09-01' = {
  parent: endpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [{ name: 'blob', properties: { privateDnsZoneId: dns.id } }]
  }
}
output endpointId string = endpoint.id
output endpointPrivateIp string = endpointPrivateIp
