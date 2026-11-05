// P3 network containment for the dedicated VM P3 subnet. This only establishes
// candidate enforcement plumbing; a workload probe and independently captured
// firewall deny records are still required before any P3 trial is measurable.
param location string = resourceGroup().location
param vnetName string
param firewallName string
param firewallPolicyName string
param logWorkspaceId string
param routeTableName string = 'thesis-vm-p3-routes'
param vmP3SubnetPrefix string = '10.48.8.0/24'
param researchServicePrivateIp string = '10.48.9.4'
param researchServicePort int = 443
param collectorPrivateIp string = '10.48.9.5'
param blobPrivateEndpointIp string = '10.48.4.7'
@description('All current routes in thesis-p3-svc-return-routes, passed through unchanged except for replacement of the named P3 return route.')
param serviceReturnExistingRoutes array
@description('All current routes in thesis-p3-pe-return-routes, passed through unchanged except for replacement of the named P3 return route.')
param privateEndpointReturnExistingRoutes array

resource vnet 'Microsoft.Network/virtualNetworks@2023-09-01' existing = {
  name: vnetName
}
var currentVmP3Subnet = reference(resourceId('Microsoft.Network/virtualNetworks/subnets', vnetName, 'vm-p3'), '2023-09-01').properties
var currentResearchSubnet = reference(resourceId('Microsoft.Network/virtualNetworks/subnets', vnetName, 'research-services'), '2023-09-01').properties
var currentPrivateEndpointSubnet = reference(resourceId('Microsoft.Network/virtualNetworks/subnets', vnetName, 'evidence-private-endpoints'), '2023-09-01').properties
resource firewall 'Microsoft.Network/azureFirewalls@2023-09-01' existing = {
  name: firewallName
}
resource policy 'Microsoft.Network/firewallPolicies@2023-09-01' existing = {
  name: firewallPolicyName
}

resource vmP3RouteTable 'Microsoft.Network/routeTables@2023-09-01' = {
  name: routeTableName
  location: location
  properties: {
    disableBgpRoutePropagation: true
    routes: [
      { name: 'default-to-firewall', properties: { addressPrefix: '0.0.0.0/0', nextHopType: 'VirtualAppliance', nextHopIpAddress: firewall.properties.ipConfigurations[0].properties.privateIPAddress } }
      { name: 'vnet-to-firewall', properties: { addressPrefix: '10.48.0.0/16', nextHopType: 'VirtualAppliance', nextHopIpAddress: firewall.properties.ipConfigurations[0].properties.privateIPAddress } }
    ]
  }
}

resource vmP3Rules 'Microsoft.Network/firewallPolicies/ruleCollectionGroups@2023-09-01' = {
  parent: policy
  name: 'vm-p3-selective-egress'
  properties: {
    priority: 220
    ruleCollections: [
      {
        name: 'vm-p3-allow-controlled-destinations'
        ruleCollectionType: 'FirewallPolicyFilterRuleCollection'
        priority: 100
        action: { type: 'Allow' }
        rules: [
          { ruleType: 'NetworkRule', name: 'vm-p3-allow-research', ipProtocols: ['TCP'], sourceAddresses: [vmP3SubnetPrefix], destinationAddresses: [researchServicePrivateIp], destinationPorts: [string(researchServicePort)] }
          { ruleType: 'NetworkRule', name: 'vm-p3-allow-fixture-blob', ipProtocols: ['TCP'], sourceAddresses: [vmP3SubnetPrefix], destinationAddresses: [blobPrivateEndpointIp], destinationPorts: ['443'] }
        ]
      }
      {
        name: 'vm-p3-deny-restricted-destinations'
        ruleCollectionType: 'FirewallPolicyFilterRuleCollection'
        priority: 110
        action: { type: 'Deny' }
        rules: [
          { ruleType: 'NetworkRule', name: 'vm-p3-deny-collector', ipProtocols: ['TCP', 'UDP'], sourceAddresses: [vmP3SubnetPrefix], destinationAddresses: [collectorPrivateIp], destinationPorts: ['*'] }
        ]
      }
      {
        name: 'vm-p3-deny-all-other-egress'
        ruleCollectionType: 'FirewallPolicyFilterRuleCollection'
        priority: 120
        action: { type: 'Deny' }
        rules: [
          { ruleType: 'NetworkRule', name: 'vm-p3-default-deny', ipProtocols: ['Any'], sourceAddresses: [vmP3SubnetPrefix], destinationAddresses: ['*'], destinationPorts: ['*'] }
        ]
      }
    ]
  }
}

resource serviceReturnRoutes 'Microsoft.Network/routeTables@2023-09-01' = {
  name: 'thesis-p3-svc-return-routes'
  location: location
  properties: {
    disableBgpRoutePropagation: false
    routes: concat(filter(serviceReturnExistingRoutes, route => route.name != 'vm-p3-return-via-firewall'), [
      { name: 'vm-p3-return-via-firewall', properties: { addressPrefix: vmP3SubnetPrefix, nextHopType: 'VirtualAppliance', nextHopIpAddress: firewall.properties.ipConfigurations[0].properties.privateIPAddress } }
    ])
  }
}
resource privateEndpointReturnRoutes 'Microsoft.Network/routeTables@2023-09-01' = {
  name: 'thesis-p3-pe-return-routes'
  location: location
  properties: {
    disableBgpRoutePropagation: false
    routes: concat(filter(privateEndpointReturnExistingRoutes, route => route.name != 'vm-p3-return-via-firewall'), [
      { name: 'vm-p3-return-via-firewall', properties: { addressPrefix: vmP3SubnetPrefix, nextHopType: 'VirtualAppliance', nextHopIpAddress: firewall.properties.ipConfigurations[0].properties.privateIPAddress } }
    ])
  }
}

resource attachVmP3Subnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' = {
  parent: vnet
  name: 'vm-p3'
  dependsOn: [vmP3RouteTable, vmP3Rules]
  properties: {
    addressPrefix: vmP3SubnetPrefix
    networkSecurityGroup: empty(currentVmP3Subnet.networkSecurityGroup) ? null : { id: currentVmP3Subnet.networkSecurityGroup.id }
    serviceEndpoints: currentVmP3Subnet.serviceEndpoints
    serviceEndpointPolicies: currentVmP3Subnet.serviceEndpointPolicies
    delegations: currentVmP3Subnet.delegations
    privateEndpointNetworkPolicies: currentVmP3Subnet.privateEndpointNetworkPolicies
    routeTable: { id: vmP3RouteTable.id }
  }
}
resource attachResearchSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' = {
  parent: vnet
  name: 'research-services'
  dependsOn: [serviceReturnRoutes, attachVmP3Subnet]
  properties: {
    addressPrefix: '10.48.9.0/24'
    networkSecurityGroup: empty(currentResearchSubnet.networkSecurityGroup) ? null : { id: currentResearchSubnet.networkSecurityGroup.id }
    serviceEndpoints: currentResearchSubnet.serviceEndpoints
    serviceEndpointPolicies: currentResearchSubnet.serviceEndpointPolicies
    delegations: currentResearchSubnet.delegations
    privateEndpointNetworkPolicies: currentResearchSubnet.privateEndpointNetworkPolicies
    routeTable: { id: serviceReturnRoutes.id }
  }
}
resource attachPrivateEndpointSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' = {
  parent: vnet
  name: 'evidence-private-endpoints'
  dependsOn: [privateEndpointReturnRoutes, attachResearchSubnet]
  properties: {
    addressPrefix: '10.48.4.0/27'
    networkSecurityGroup: empty(currentPrivateEndpointSubnet.networkSecurityGroup) ? null : { id: currentPrivateEndpointSubnet.networkSecurityGroup.id }
    serviceEndpoints: currentPrivateEndpointSubnet.serviceEndpoints
    serviceEndpointPolicies: currentPrivateEndpointSubnet.serviceEndpointPolicies
    delegations: currentPrivateEndpointSubnet.delegations
    privateEndpointNetworkPolicies: 'RouteTableEnabled'
    routeTable: { id: privateEndpointReturnRoutes.id }
  }
}

resource firewallDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: firewall
  name: 'vm-p3-egress-audit'
  properties: {
    workspaceId: logWorkspaceId
    logs: [
      { category: 'AzureFirewallApplicationRule', enabled: true }
      { category: 'AzureFirewallNetworkRule', enabled: true }
    ]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

output candidateEnabled bool = true
output firewallPrivateIp string = firewall.properties.ipConfigurations[0].properties.privateIPAddress
output vmP3RouteTableId string = vmP3RouteTable.id
output vmP3RuleCollectionGroupId string = vmP3Rules.id
