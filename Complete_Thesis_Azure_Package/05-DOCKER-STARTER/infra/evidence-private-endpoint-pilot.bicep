// Candidate private Blob path. This does not connect the laptop controller to
// the VNet or prove workload isolation; establish a trusted route and DNS.
param location string = resourceGroup().location
param endpointName string
@description('ID of the shared Blob private DNS zone created by the parent composition.')
param blobDnsZoneId string
param endpointSubnetId string
@description('Static private IP inside the endpoint subnet, reserved for this Blob endpoint.')
param endpointPrivateIp string
param storageAccountId string

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
    privateDnsZoneConfigs: [{ name: 'blob', properties: { privateDnsZoneId: blobDnsZoneId } }]
  }
}
output endpointId string = endpoint.id
output endpointPrivateIp string = endpointPrivateIp
