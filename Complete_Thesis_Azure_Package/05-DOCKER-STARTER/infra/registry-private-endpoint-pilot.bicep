// Candidate private access for the Premium ACR created by diagnostic-dependencies.
// It keeps session image pulls on the VNet and allows the session NSG to permit
// only the actual registry/data endpoint IPs. Controller push access remains
// restricted by the ACR public IP rule supplied to the dependencies template.
param location string = resourceGroup().location
param endpointName string
param virtualNetworkId string
param endpointSubnetId string
param registryId string

resource dns 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: 'privatelink.azurecr.io'
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
    privateLinkServiceConnections: [{
      name: 'registry'
      properties: { privateLinkServiceId: registryId, groupIds: ['registry'] }
    }]
  }
}
resource dnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-09-01' = {
  parent: endpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [{ name: 'registry', properties: { privateDnsZoneId: dns.id } }]
  }
}
output endpointId string = endpoint.id
output registryPrivateEndpointIps array = endpoint.properties.customDnsConfigs[0].ipAddresses
