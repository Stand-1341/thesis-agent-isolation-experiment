// Reuse the existing Blob private DNS zone and its VNet link. This endpoint
// does not prove access control or routing from any workload.
param location string = resourceGroup().location
param endpointName string
param endpointSubnetId string
param endpointPrivateIp string
param storageAccountId string

resource dns 'Microsoft.Network/privateDnsZones@2020-06-01' existing = {
  name: 'privatelink.blob.${environment().suffixes.storage}'
}
resource endpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = {
  name: endpointName
  location: location
  properties: {
    subnet: { id: endpointSubnetId }
    ipConfigurations: [{ name: 'blob-ip', properties: { groupId: 'blob', memberName: 'blob', privateIPAddress: endpointPrivateIp } }]
    privateLinkServiceConnections: [{ name: 'blob', properties: { privateLinkServiceId: storageAccountId, groupIds: ['blob'] } }]
  }
}
resource dnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-09-01' = {
  parent: endpoint
  name: 'default'
  properties: { privateDnsZoneConfigs: [{ name: 'blob', properties: { privateDnsZoneId: dns.id } }] }
}
output endpointId string = endpoint.id
