// Dedicated private subnet and existing Azure Firewall egress for the ACI
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
param routeTableName string = 'thesis-p3-routes'
param peReturnRouteTableName string = 'thesis-p3-pe-return-routes'
param serviceReturnRouteTableName string = 'thesis-p3-svc-return-routes'
@description('Current private IP of the existing Azure Firewall.')
param firewallPrivateIp string = '10.48.10.4'

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' existing = {
  name: vnetName
}

resource routeTable 'Microsoft.Network/routeTables@2023-09-01' existing = {
  name: routeTableName
}

resource peReturnRouteTable 'Microsoft.Network/routeTables@2023-09-01' existing = {
  name: peReturnRouteTableName
}

resource serviceReturnRouteTable 'Microsoft.Network/routeTables@2023-09-01' existing = {
  name: serviceReturnRouteTableName
}

resource peReturnRoute 'Microsoft.Network/routeTables/routes@2023-09-01' = {
  parent: peReturnRouteTable
  name: 'aci-experiment-return'
  properties: {
    addressPrefix: subnetPrefix
    nextHopType: 'VirtualAppliance'
    nextHopIpAddress: firewallPrivateIp
  }
}

resource serviceReturnRoute 'Microsoft.Network/routeTables/routes@2023-09-01' = {
  parent: serviceReturnRouteTable
  name: 'aci-experiment-return'
  properties: {
    addressPrefix: subnetPrefix
    nextHopType: 'VirtualAppliance'
    nextHopIpAddress: firewallPrivateIp
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
    routeTable: { id: routeTable.id }
    networkSecurityGroup: { id: nsg.id }
    delegations: [{
      name: 'aci-container-groups'
      properties: { serviceName: 'Microsoft.ContainerInstance/containerGroups' }
    }]
  }
}

output subnetId string = subnet.id
output routeTableId string = routeTable.id
