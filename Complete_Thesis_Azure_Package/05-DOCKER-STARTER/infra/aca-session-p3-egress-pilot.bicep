// Candidate P3 egress boundary for the ACA dynamic-session workload profile.
// This is not proof that session packets honor the environment UDR/firewall.
// Deploy only in a disposable pilot, then verify by domain, direct IP, and
// redirects while collecting independent Azure Firewall/Network Watcher logs.
param location string = resourceGroup().location
param vnetName string
param sessionSubnetPrefix string = '10.48.2.0/23'
@minLength(1)
@description('Existing session subnet NSG ID. Required so redeployment cannot silently remove it.')
param sessionNsgId string
param firewallName string
param firewallPublicIpName string
param firewallManagementPublicIpName string
param firewallPolicyName string
@description('Exact management FQDN used by the trusted pilot controller to route requests into this pool.')
param sessionManagementEndpointFqdn string
param routeTableName string
param serviceReturnRouteTableName string
param privateEndpointReturnRouteTableName string
param researchSubnetPrefix string = '10.48.9.0/24'
param privateEndpointSubnetPrefix string = '10.48.4.0/27'
param researchServicePrivateIp string
@description('Distinct fixed private IP that serves the prohibited collector endpoint.')
param collectorPrivateIp string
@minValue(1)
@maxValue(65535)
param researchServicePort int
param blobPrivateEndpointIp string
@minLength(1)
@description('All registry and regional data endpoint private IPs from the ACR private endpoint NIC.')
param registryPrivateEndpointIps array
param logWorkspaceId string

resource vnet 'Microsoft.Network/virtualNetworks@2023-09-01' existing = { name: vnetName }
resource firewallSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' existing = {
  parent: vnet
  name: 'AzureFirewallSubnet'
}
resource firewallManagementSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' existing = {
  parent: vnet
  name: 'AzureFirewallManagementSubnet'
}

resource firewallPublicIp 'Microsoft.Network/publicIPAddresses@2023-09-01' = {
  name: firewallPublicIpName
  location: location
  sku: { name: 'Standard', tier: 'Regional' }
  properties: { publicIPAllocationMethod: 'Static', ddosSettings: { protectionMode: 'VirtualNetworkInherited' } }
}
resource firewallManagementPublicIp 'Microsoft.Network/publicIPAddresses@2023-09-01' = {
  name: firewallManagementPublicIpName
  location: location
  sku: { name: 'Standard', tier: 'Regional' }
  properties: { publicIPAllocationMethod: 'Static', ddosSettings: { protectionMode: 'VirtualNetworkInherited' } }
}

resource policy 'Microsoft.Network/firewallPolicies@2023-09-01' = {
  name: firewallPolicyName
  location: location
  properties: {
    sku: { tier: 'Basic' }
    // Basic Firewall supports threat intelligence alerting but not deny mode.
    threatIntelMode: 'Alert'
  }
}

resource requiredRules 'Microsoft.Network/firewallPolicies/ruleCollectionGroups@2023-09-01' = {
  parent: policy
  name: 'required-aca-egress'
  properties: {
    priority: 100
    ruleCollections: [
      {
        name: 'required-platform-https'
        ruleCollectionType: 'FirewallPolicyFilterRuleCollection'
        priority: 100
        action: { type: 'Allow' }
        rules: [
          {
            ruleType: 'ApplicationRule'
            name: 'aca-platform-and-identity'
            sourceAddresses: [sessionSubnetPrefix]
            protocols: [ { protocolType: 'Https', port: 443 } ]
            targetFqdns: [
              'mcr.microsoft.com'
              '*.data.mcr.microsoft.com'
              'packages.aks.azure.com'
              'acs-mirror.azureedge.net'
              '*.identity.azure.net'
              sessionManagementEndpointFqdn
              split(replace(environment().authentication.loginEndpoint, 'https://', ''), '/')[0]
              '*.${split(replace(environment().authentication.loginEndpoint, 'https://', ''), '/')[0]}'
              '*.login.microsoft.com'
            ]
          }
        ]
      }
      {
        name: 'required-platform-network'
        ruleCollectionType: 'FirewallPolicyFilterRuleCollection'
        priority: 110
        action: { type: 'Allow' }
        rules: [
          {
            ruleType: 'NetworkRule'
            name: 'identity-and-monitoring'
            ipProtocols: [ 'TCP' ]
            sourceAddresses: [sessionSubnetPrefix]
            destinationAddresses: [ 'AzureActiveDirectory', 'AzureMonitor' ]
            destinationPorts: [ '443' ]
          }
        ]
      }
    ]
  }
}

// Inspect both private and public egress through the firewall. The specific
// private destinations are allowed; the collector is explicitly denied and
// unmatched traffic falls through to Azure Firewall's default deny.
resource p3PrivateRules 'Microsoft.Network/firewallPolicies/ruleCollectionGroups@2023-09-01' = {
  parent: policy
  name: 'p3-selective-egress'
  // Azure serializes rule group writes per policy. Apply the private-boundary
  // group only after the required ACA egress group has finished updating.
  dependsOn: [ requiredRules ]
  properties: {
    priority: 200
    ruleCollections: [
      {
        name: 'allow-research-and-fixtures'
        ruleCollectionType: 'FirewallPolicyFilterRuleCollection'
        priority: 100
        action: { type: 'Allow' }
        rules: [
          {
            ruleType: 'NetworkRule'
            name: 'allow-research-api'
            ipProtocols: [ 'TCP' ]
            sourceAddresses: [sessionSubnetPrefix]
            destinationAddresses: [researchServicePrivateIp]
            destinationPorts: [string(researchServicePort)]
          }
          {
            ruleType: 'NetworkRule'
            name: 'allow-synthetic-blob'
            ipProtocols: [ 'TCP' ]
            sourceAddresses: [sessionSubnetPrefix]
            destinationAddresses: [blobPrivateEndpointIp]
            destinationPorts: [ '443' ]
          }
          {
            ruleType: 'NetworkRule'
            name: 'allow-private-registry'
            ipProtocols: [ 'TCP' ]
            sourceAddresses: [sessionSubnetPrefix]
            destinationAddresses: registryPrivateEndpointIps
            destinationPorts: [ '443' ]
          }
        ]
      }
      {
        name: 'deny-restricted-collector'
        ruleCollectionType: 'FirewallPolicyFilterRuleCollection'
        priority: 110
        action: { type: 'Deny' }
        rules: [
          {
            ruleType: 'NetworkRule'
            name: 'deny-collector'
            ipProtocols: [ 'TCP', 'UDP' ]
            sourceAddresses: [sessionSubnetPrefix]
            destinationAddresses: [collectorPrivateIp]
            destinationPorts: [ '*' ]
          }
        ]
      }
    ]
  }
}

resource firewall 'Microsoft.Network/azureFirewalls@2023-09-01' = {
  name: firewallName
  location: location
  // Install policy rule groups before associating a new firewall with the policy.
  dependsOn: [ p3PrivateRules ]
  properties: {
    sku: { name: 'AZFW_VNet', tier: 'Basic' }
    firewallPolicy: { id: policy.id }
    ipConfigurations: [
      {
        name: 'configuration'
        properties: {
          subnet: { id: firewallSubnet.id }
          publicIPAddress: { id: firewallPublicIp.id }
        }
      }
    ]
    managementIpConfiguration: {
      name: 'management'
      properties: {
        subnet: { id: firewallManagementSubnet.id }
        publicIPAddress: { id: firewallManagementPublicIp.id }
      }
    }
  }
}

resource routeTable 'Microsoft.Network/routeTables@2023-09-01' = {
  name: routeTableName
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

resource serviceReturnRoutes 'Microsoft.Network/routeTables@2023-09-01' = {
  name: serviceReturnRouteTableName
  location: location
  properties: { routes: [{ name: 'session-return-via-firewall', properties: { addressPrefix: sessionSubnetPrefix, nextHopType: 'VirtualAppliance', nextHopIpAddress: firewall.properties.ipConfigurations[0].properties.privateIPAddress } }] }
}

resource endpointReturnRoutes 'Microsoft.Network/routeTables@2023-09-01' = {
  name: privateEndpointReturnRouteTableName
  location: location
  properties: { routes: [{ name: 'session-return-via-firewall', properties: { addressPrefix: sessionSubnetPrefix, nextHopType: 'VirtualAppliance', nextHopIpAddress: firewall.properties.ipConfigurations[0].properties.privateIPAddress } }] }
}

resource sessionsSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' = {
  parent: vnet
  name: 'sessions-pilot'
  properties: {
    addressPrefix: sessionSubnetPrefix
    privateEndpointNetworkPolicies: 'Disabled'
    delegations: [
      {
        name: 'sessions-delegation'
        properties: { serviceName: 'Microsoft.App/environments' }
      }
    ]
    routeTable: { id: routeTable.id }
    networkSecurityGroup: { id: sessionNsgId }
  }
}

resource serviceSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' = {
  parent: vnet
  name: 'research-services'
  // Subnet child writes share a parent VNet operation lock in ARM.
  dependsOn: [ sessionsSubnet ]
  properties: {
    addressPrefix: researchSubnetPrefix
    privateEndpointNetworkPolicies: 'Disabled'
    routeTable: { id: serviceReturnRoutes.id }
  }
}

resource privateEndpointSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' = {
  parent: vnet
  name: 'evidence-private-endpoints'
  dependsOn: [ serviceSubnet ]
  properties: {
    addressPrefix: privateEndpointSubnetPrefix
    privateEndpointNetworkPolicies: 'RouteTableEnabled'
    routeTable: { id: endpointReturnRoutes.id }
  }
}

resource firewallDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: firewall
  name: 'session-egress-audit'
  properties: {
    workspaceId: logWorkspaceId
    logs: [
      { category: 'AzureFirewallApplicationRule', enabled: true }
      { category: 'AzureFirewallNetworkRule', enabled: true }
      { category: 'AzureFirewallDnsProxy', enabled: true }
    ]
    metrics: [ { category: 'AllMetrics', enabled: true } ]
  }
}

output firewallId string = firewall.id
output firewallPrivateIp string = firewall.properties.ipConfigurations[0].properties.privateIPAddress
output routeTableId string = routeTable.id
output serviceReturnRouteTableId string = serviceReturnRoutes.id
output privateEndpointReturnRouteTableId string = endpointReturnRoutes.id
output sessionSubnetId string = sessionsSubnet.id
