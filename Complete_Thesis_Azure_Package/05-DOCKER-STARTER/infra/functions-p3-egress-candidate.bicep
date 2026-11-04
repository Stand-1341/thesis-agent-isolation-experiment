// DISABLED-BY-DEFAULT candidate only for the Azure Functions Flex P3 route.
// It forces the P3 delegated subnet through the existing Azure Firewall, adds
// source-specific firewall rules, and configures symmetric return routes for
// the existing session and proposed Functions P3 subnets. It does not prove
// Flex traffic honors these routes or that the platform rule list is complete.
// Do not set enableCandidate=true until the firewall policy, current return
// routes, Function host-storage requirements, and cost impact are reviewed.
param location string = resourceGroup().location
param enableCandidate bool = false
param vnetName string
param firewallName string
param firewallPolicyName string
@description('Existing Functions P3 integration subnet prefix. Dedicated Flex subnet, delegated to Microsoft.App/environments.')
param functionP3SubnetPrefix string
@description('Research API private IP and TCP port. Must be confirmed from the deployed service NIC and listener.')
param researchServicePrivateIp string
@minValue(1)
@maxValue(65535)
param researchServicePort int
@description('Collector private IP. This address is deliberately not included in allow rules.')
param collectorPrivateIp string
@description('Synthetic fixture Blob private-endpoint IP, independently resolved from its PE NIC.')
param blobPrivateEndpointIp string
@description('Exact outbound host-storage FQDNs required by this Flex app (for example its blob, queue, and table endpoints).')
@minLength(1)
param hostStorageFqdns array
@description('Additional exact Microsoft service FQDNs confirmed as required for this Flex runtime. Do not use a wildcard internet allow-list.')
@minLength(1)
param requiredFunctionFqdns array
param functionsP3RouteTableName string
param serviceReturnRouteTableName string
param privateEndpointReturnRouteTableName string
@description('Every existing route in the research-service subnet return route table. Read the live table before deployment; these entries are retained and the Functions P3 return route is appended.')
param serviceReturnExistingRoutes array
@description('Every existing route in the evidence-private-endpoints subnet return route table. Read the live table before deployment; these entries are retained and the Functions P3 return route is appended.')
param privateEndpointReturnExistingRoutes array
param logWorkspaceId string

resource vnet 'Microsoft.Network/virtualNetworks@2023-09-01' existing = {
  name: vnetName
}
// These subnet PUTs attach the new return routes. Read the current subnet
// configuration so existing security and service-endpoint associations are
// carried forward instead of being cleared by an incomplete resource body.
resource existingResearchSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' existing = {
  parent: vnet
  name: 'research-services'
}
resource existingPrivateEndpointSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' existing = {
  parent: vnet
  name: 'evidence-private-endpoints'
}
resource firewall 'Microsoft.Network/azureFirewalls@2023-09-01' existing = {
  name: firewallName
}
resource policy 'Microsoft.Network/firewallPolicies@2023-09-01' existing = {
  name: firewallPolicyName
}

resource platformRules 'Microsoft.Network/firewallPolicies/ruleCollectionGroups@2023-09-01' = if (enableCandidate) {
  parent: policy
  name: 'required-functions-p3-egress'
  properties: {
    priority: 120
    ruleCollections: [
      {
        name: 'functions-p3-platform-https'
        ruleCollectionType: 'FirewallPolicyFilterRuleCollection'
        priority: 100
        action: { type: 'Allow' }
        rules: [
          {
            ruleType: 'ApplicationRule'
            name: 'functions-flex-required-fqdns'
            sourceAddresses: [functionP3SubnetPrefix]
            protocols: [{ protocolType: 'Https', port: 443 }]
            targetFqdns: concat(hostStorageFqdns, requiredFunctionFqdns)
          }
        ]
      }
      {
        name: 'functions-p3-platform-service-tags'
        ruleCollectionType: 'FirewallPolicyFilterRuleCollection'
        priority: 110
        action: { type: 'Allow' }
        rules: [
          {
            ruleType: 'NetworkRule'
            name: 'functions-flex-identity-monitoring-storage'
            ipProtocols: ['TCP']
            sourceAddresses: [functionP3SubnetPrefix]
            // Keep this explicit and review the platform requirements before enabling.
            destinationAddresses: ['AzureActiveDirectory', 'AzureMonitor', 'Storage.EastUS']
            destinationPorts: ['443']
          }
        ]
      }
    ]
  }
}

resource selectiveRules 'Microsoft.Network/firewallPolicies/ruleCollectionGroups@2023-09-01' = if (enableCandidate) {
  parent: policy
  name: 'functions-p3-selective-egress'
  dependsOn: [platformRules]
  properties: {
    priority: 220
    ruleCollections: [
      {
        name: 'functions-p3-allow-research-and-fixtures'
        ruleCollectionType: 'FirewallPolicyFilterRuleCollection'
        priority: 100
        action: { type: 'Allow' }
        rules: [
          {
            ruleType: 'NetworkRule'
            name: 'functions-p3-allow-research'
            ipProtocols: ['TCP']
            sourceAddresses: [functionP3SubnetPrefix]
            destinationAddresses: [researchServicePrivateIp]
            destinationPorts: [string(researchServicePort)]
          }
          {
            ruleType: 'NetworkRule'
            name: 'functions-p3-allow-fixture-blob'
            ipProtocols: ['TCP']
            sourceAddresses: [functionP3SubnetPrefix]
            destinationAddresses: [blobPrivateEndpointIp]
            destinationPorts: ['443']
          }
        ]
      }
      {
        name: 'functions-p3-deny-restricted-collector'
        ruleCollectionType: 'FirewallPolicyFilterRuleCollection'
        priority: 110
        action: { type: 'Deny' }
        rules: [
          {
            ruleType: 'NetworkRule'
            name: 'functions-p3-deny-collector'
            ipProtocols: ['TCP', 'UDP']
            sourceAddresses: [functionP3SubnetPrefix]
            destinationAddresses: [collectorPrivateIp]
            destinationPorts: ['*']
          }
        ]
      }
    ]
  }
}

resource functionsP3RouteTable 'Microsoft.Network/routeTables@2023-09-01' = if (enableCandidate) {
  name: functionsP3RouteTableName
  location: location
  properties: {
    disableBgpRoutePropagation: true
    routes: [
      {
        name: 'default-to-firewall'
        properties: {
          addressPrefix: '0.0.0.0/0'
          nextHopType: 'VirtualAppliance'
          nextHopIpAddress: firewall.properties.ipConfigurations[0].properties.privateIPAddress
        }
      }
      {
        name: 'vnet-to-firewall'
        properties: {
          addressPrefix: '10.48.0.0/16'
          nextHopType: 'VirtualAppliance'
          nextHopIpAddress: firewall.properties.ipConfigurations[0].properties.privateIPAddress
        }
      }
    ]
  }
}

// Azure Resource Manager replaces route lists on these resources. Require the
// operator to read and pass every current route, then append the P3 return path;
// this avoids silently dropping unrelated routes when the candidate is enabled.
resource serviceReturnRoutes 'Microsoft.Network/routeTables@2023-09-01' = if (enableCandidate) {
  name: serviceReturnRouteTableName
  location: location
  properties: {
    routes: concat(filter(serviceReturnExistingRoutes, route => route.name != 'functions-p3-return-via-firewall'), [
      { name: 'functions-p3-return-via-firewall', properties: { addressPrefix: functionP3SubnetPrefix, nextHopType: 'VirtualAppliance', nextHopIpAddress: firewall.properties.ipConfigurations[0].properties.privateIPAddress } }
    ])
  }
}
resource privateEndpointReturnRoutes 'Microsoft.Network/routeTables@2023-09-01' = if (enableCandidate) {
  name: privateEndpointReturnRouteTableName
  location: location
  properties: {
    routes: concat(filter(privateEndpointReturnExistingRoutes, route => route.name != 'functions-p3-return-via-firewall'), [
      { name: 'functions-p3-return-via-firewall', properties: { addressPrefix: functionP3SubnetPrefix, nextHopType: 'VirtualAppliance', nextHopIpAddress: firewall.properties.ipConfigurations[0].properties.privateIPAddress } }
    ])
  }
}

resource functionsP3Subnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' = if (enableCandidate) {
  parent: vnet
  name: 'functions-p3'
  properties: {
    addressPrefix: functionP3SubnetPrefix
    delegations: [{ name: 'functions-delegation', properties: { serviceName: 'Microsoft.App/environments' } }]
    routeTable: { id: functionsP3RouteTable.id }
  }
}
resource updateResearchSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' = if (enableCandidate) {
  parent: vnet
  name: 'research-services'
  dependsOn: [functionsP3Subnet]
  properties: {
    addressPrefix: '10.48.9.0/24'
    networkSecurityGroup: empty(existingResearchSubnet.properties.networkSecurityGroup) ? null : { id: existingResearchSubnet.properties.networkSecurityGroup.id }
    serviceEndpoints: existingResearchSubnet.properties.serviceEndpoints
    serviceEndpointPolicies: existingResearchSubnet.properties.serviceEndpointPolicies
    delegations: existingResearchSubnet.properties.delegations
    privateEndpointNetworkPolicies: existingResearchSubnet.properties.privateEndpointNetworkPolicies
    routeTable: { id: serviceReturnRoutes.id }
  }
}
resource updatePrivateEndpointSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' = if (enableCandidate) {
  parent: vnet
  name: 'evidence-private-endpoints'
  dependsOn: [updateResearchSubnet]
  properties: {
    addressPrefix: '10.48.4.0/27'
    networkSecurityGroup: empty(existingPrivateEndpointSubnet.properties.networkSecurityGroup) ? null : { id: existingPrivateEndpointSubnet.properties.networkSecurityGroup.id }
    serviceEndpoints: existingPrivateEndpointSubnet.properties.serviceEndpoints
    serviceEndpointPolicies: existingPrivateEndpointSubnet.properties.serviceEndpointPolicies
    delegations: existingPrivateEndpointSubnet.properties.delegations
    privateEndpointNetworkPolicies: 'RouteTableEnabled'
    routeTable: { id: privateEndpointReturnRoutes.id }
  }
}

resource firewallDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (enableCandidate) {
  scope: firewall
  name: 'functions-p3-egress-audit'
  properties: {
    workspaceId: logWorkspaceId
    logs: [
      { category: 'AzureFirewallApplicationRule', enabled: true }
      { category: 'AzureFirewallNetworkRule', enabled: true }
    ]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

output candidateEnabled bool = enableCandidate
output firewallId string = firewall.id
output firewallPrivateIp string = firewall.properties.ipConfigurations[0].properties.privateIPAddress
output functionsP3RouteTableId string = enableCandidate ? functionsP3RouteTable.id : ''
