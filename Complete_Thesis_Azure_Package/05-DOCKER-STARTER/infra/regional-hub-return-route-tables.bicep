targetScope = 'resourceGroup'

param location string
param serviceRouteTableName string
param privateEndpointRouteTableName string

// Created during foundation with no routes. The full regional P3 deployment
// later adds only its two exact return prefixes through the regional firewall.
resource serviceReturnRouteTable 'Microsoft.Network/routeTables@2023-09-01' = {
  name: serviceRouteTableName
  location: location
  properties: { routes: [] }
}

resource privateEndpointReturnRouteTable 'Microsoft.Network/routeTables@2023-09-01' = {
  name: privateEndpointRouteTableName
  location: location
  properties: { routes: [] }
}

output serviceRouteTableId string = serviceReturnRouteTable.id
output privateEndpointRouteTableId string = privateEndpointReturnRouteTable.id
