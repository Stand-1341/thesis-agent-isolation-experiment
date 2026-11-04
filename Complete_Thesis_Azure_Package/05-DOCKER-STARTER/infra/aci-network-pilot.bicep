// Dedicated private subnet and supported NAT Gateway egress for the ACI
// replacement pilot. P1/P2 only: no ACI P3 or selective-egress claim is implied.
param location string = resourceGroup().location
param vnetName string
@description('Keep this subnet exclusive to Azure Container Instances container groups.')
param subnetName string = 'aci-experiment'
@description('Recheck this range for overlap immediately before deployment. ACI requires a dedicated /24 for repeated group create/delete cycles.')
param subnetPrefix string = '10.48.13.0/24'
@description('Only this controller subnet can reach the agent HTTP port.')
param controllerPrefix string = '10.48.11.0/24'
param nsgName string = 'thesis-aci-agent-nsg'
param natGatewayName string = 'thesis-aci-nat'
param publicIpName string = 'thesis-aci-nat-ip'
@description('ACI VNet outbound requires a NAT Gateway. The Standard public IP consumes one regional public-IP quota unit.')
param natIdleTimeoutMinutes int = 4
param researchHostNsgName string = 'thesis-p3-targets-nsg'
param researchServiceIp string = '10.48.9.4'
param collectorServiceIp string = '10.48.9.5'
param controllerNsgName string = 'thesis-controller-pilot-nsg'

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' existing = {
  name: vnetName
}

resource researchHostNsg 'Microsoft.Network/networkSecurityGroups@2023-09-01' existing = {
  name: researchHostNsgName
}

resource controllerNsg 'Microsoft.Network/networkSecurityGroups@2023-09-01' existing = {
  name: controllerNsgName
}

resource allowControllerToAci 'Microsoft.Network/networkSecurityGroups/securityRules@2023-09-01' = {
  parent: controllerNsg
  name: 'controller-to-aci-agent-http'
  properties: {
    priority: 120
    direction: 'Outbound'
    access: 'Allow'
    protocol: 'Tcp'
    sourceAddressPrefix: controllerPrefix
    sourcePortRange: '*'
    destinationAddressPrefix: subnetPrefix
    destinationPortRange: '8080'
  }
}

resource allowAciResearch 'Microsoft.Network/networkSecurityGroups/securityRules@2023-09-01' = {
  parent: researchHostNsg
  name: 'aci-p1p2-research-https'
  properties: {
    priority: 145
    direction: 'Inbound'
    access: 'Allow'
    protocol: 'Tcp'
    sourceAddressPrefix: subnetPrefix
    sourcePortRange: '*'
    destinationAddressPrefix: researchServiceIp
    destinationPortRange: '443'
  }
}

resource allowAciCollector 'Microsoft.Network/networkSecurityGroups/securityRules@2023-09-01' = {
  parent: researchHostNsg
  name: 'aci-p1p2-collector-https'
  properties: {
    priority: 155
    direction: 'Inbound'
    access: 'Allow'
    protocol: 'Tcp'
    sourceAddressPrefix: subnetPrefix
    sourcePortRange: '*'
    destinationAddressPrefix: collectorServiceIp
    destinationPortRange: '8443'
  }
}

resource publicIp 'Microsoft.Network/publicIPAddresses@2023-09-01' = {
  name: publicIpName
  location: location
  sku: { name: 'Standard' }
  properties: { publicIPAllocationMethod: 'Static' }
}

resource natGateway 'Microsoft.Network/natGateways@2023-09-01' = {
  name: natGatewayName
  location: location
  sku: { name: 'Standard' }
  properties: {
    idleTimeoutInMinutes: natIdleTimeoutMinutes
    publicIpAddresses: [{ id: publicIp.id }]
  }
}

resource nsg 'Microsoft.Network/networkSecurityGroups@2023-09-01' = {
  name: nsgName
  location: location
  tags: { experimentRoute: 'azure_container_instances', phase: 'pilot', p3Validated: 'false' }
  properties: {
    securityRules: [
      {
        name: 'controller-agent-http'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: controllerPrefix
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '8080'
        }
      }
      {
        name: 'azure-platform-management'
        properties: {
          priority: 110
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'AzureLoadBalancer'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '19390'
        }
      }
      {
        name: 'deny-other-inbound'
        properties: {
          priority: 4000
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

resource subnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: vnet
  name: subnetName
  properties: {
    addressPrefix: subnetPrefix
    networkSecurityGroup: { id: nsg.id }
    natGateway: { id: natGateway.id }
    privateEndpointNetworkPolicies: 'Disabled'
    privateLinkServiceNetworkPolicies: 'Enabled'
    delegations: [{
      name: 'aci-container-groups'
      properties: { serviceName: 'Microsoft.ContainerInstance/containerGroups' }
    }]
  }
}

output subnetId string = subnet.id
output natGatewayId string = natGateway.id
output natPublicIp string = publicIp.properties.ipAddress
