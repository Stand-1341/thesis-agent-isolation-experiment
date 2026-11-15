targetScope = 'resourceGroup'

param routeTableName string
param namePrefix string
param vmP3SubnetPrefix string
param jobsP3EnvironmentSubnetPrefix string
param firewallPrivateIp string

resource routeTable 'Microsoft.Network/routeTables@2023-09-01' existing = { name: routeTableName }

resource returnRoutes 'Microsoft.Network/routeTables/routes@2023-09-01' = [for (prefix, index) in [vmP3SubnetPrefix, jobsP3EnvironmentSubnetPrefix]: {
  parent: routeTable
  name: '${namePrefix}-p3-return-${index}'
  properties: {
    addressPrefix: prefix
    nextHopType: 'VirtualAppliance'
    nextHopIpAddress: firewallPrivateIp
  }
}]

output routeIds array = [for (prefix, index) in [vmP3SubnetPrefix, jobsP3EnvironmentSubnetPrefix]: returnRoutes[index].id]
