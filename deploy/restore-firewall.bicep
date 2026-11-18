targetScope = 'resourceGroup'

@description('Azure region for the restored firewall.')
param location string = resourceGroup().location

@description('Existing firewall policy name.')
param firewallPolicyName string = 'th30f2e487-fw-policy'

@description('Existing virtual network name.')
param vnetName string = 'th30f2e487-vnet'

@description('Firewall name to restore.')
param firewallName string = 'th30f2e487-fw'

@description('Log Analytics workspace for firewall diagnostics.')
param logWorkspaceId string = resourceId('Microsoft.OperationalInsights/workspaces', 'th30f2e487logs')

resource vnet 'Microsoft.Network/virtualNetworks@2023-09-01' existing = {
  name: vnetName
}

resource firewallSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' existing = {
  parent: vnet
  name: 'AzureFirewallSubnet'
}

resource managementSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' existing = {
  parent: vnet
  name: 'AzureFirewallManagementSubnet'
}

resource policy 'Microsoft.Network/firewallPolicies@2023-09-01' existing = {
  name: firewallPolicyName
}

resource firewallPublicIp 'Microsoft.Network/publicIPAddresses@2023-09-01' = {
  name: '${firewallName}-pip'
  location: location
  sku: { name: 'Standard' }
  properties: {
    publicIPAllocationMethod: 'Static'
  }
}

resource managementPublicIp 'Microsoft.Network/publicIPAddresses@2023-09-01' = {
  name: '${firewallName}-mgmt-pip'
  location: location
  sku: { name: 'Standard' }
  properties: {
    publicIPAllocationMethod: 'Static'
  }
}

resource firewall 'Microsoft.Network/azureFirewalls@2023-09-01' = {
  name: firewallName
  location: location
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
        subnet: { id: managementSubnet.id }
        publicIPAddress: { id: managementPublicIp.id }
      }
    }
  }
}

resource firewallDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: firewall
  name: 'p3-egress-audit'
  properties: {
    workspaceId: logWorkspaceId
    logs: [
      { category: 'AzureFirewallApplicationRule', enabled: true }
      { category: 'AzureFirewallNetworkRule', enabled: true }
    ]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

output firewallPrivateIp string = firewall.properties.ipConfigurations[0].properties.privateIPAddress
output firewallPublicIp string = firewallPublicIp.properties.ipAddress
