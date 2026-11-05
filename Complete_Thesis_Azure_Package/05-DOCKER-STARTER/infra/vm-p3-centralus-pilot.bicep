// Candidate P3 route in Central US. This is a separate spoke VNet so it can
// use Central US capacity while sending all hub, research, and Internet traffic
// through the existing East US Azure Firewall. This template is intentionally
// separate from vm-p3-network-controls.bicep, which targets the East US vm-p3
// subnet and must not be pointed at this route.
targetScope = 'resourceGroup'

@description('Region for the isolated P3 route spoke and workload VM.')
param location string = 'centralus'
@description('Region and VNet containing the existing hub firewall and services.')
param hubLocation string = 'eastus'
@description('Name of the existing East US hub VNet.')
param hubVnetName string = 'vnet-thesis-pilot-eus'
@description('Name of the new non-overlapping Central US spoke VNet.')
param spokeVnetName string = 'vnet-thesis-vm-p3-centralus'
param spokeAddressPrefix string = '10.49.0.0/16'
param vmP3SubnetName string = 'vm-p3'
param vmP3SubnetPrefix string = '10.49.8.0/24'
param controllerSourcePrefixes array = [
  '10.48.11.0/24'
]
param firewallName string = 'thesis-p3-fw'
param firewallPolicyName string = 'thesis-p3-fw-policy'
param routeTableName string = 'thesis-vm-p3-centralus-routes'
@description('Controller subnet route table; includes a specific Central P3 subnet route through the hub firewall to keep the controller/P3 path symmetric.')
param controllerRouteTableName string = 'thesis-controller-pilot-routes'
@description('Complete current route list from thesis-controller-pilot-routes; the deployment preserves these entries while adding the Central P3 route.')
param controllerExistingRoutes array = [
  {
    name: 'default-to-firewall'
    properties: {
      addressPrefix: '0.0.0.0/0'
      nextHopType: 'VirtualAppliance'
      nextHopIpAddress: '10.48.10.4'
    }
  }
]
param serviceReturnRouteTableName string = 'thesis-p3-svc-return-routes'
param privateEndpointReturnRouteTableName string = 'thesis-p3-pe-return-routes'
@description('Complete current routes from thesis-p3-svc-return-routes; the deployment appends the Central P3 return route while preserving these entries.')
param serviceReturnExistingRoutes array = [
  {
    name: 'session-return-via-firewall'
    properties: {
      addressPrefix: '10.48.2.0/23'
      nextHopType: 'VirtualAppliance'
      nextHopIpAddress: '10.48.10.4'
    }
  }
]
@description('Complete current routes from thesis-p3-pe-return-routes; the deployment appends the Central P3 return route while preserving these entries.')
param privateEndpointReturnExistingRoutes array = [
  {
    name: 'session-return-via-firewall'
    properties: {
      addressPrefix: '10.48.2.0/23'
      nextHopType: 'VirtualAppliance'
      nextHopIpAddress: '10.48.10.4'
    }
  }
]
param researchServicePrivateIp string = '10.48.9.4'
param collectorPrivateIp string = '10.48.9.5'
param fixtureBlobPrivateEndpointIp string = '10.48.4.7'
param vmName string = 'thesis-vm-study-p3-centralus'
param workloadIdentityName string = 'id-thesis-fixture-vm-p3'
@description('Existing Ubuntu image version used by the P1/P2 route VMs.')
param imageVersion string = '22.04.202610220'
@description('P3 SSH public key. Never pass a private key.')
param sshPublicKey string
param adminUsername string = 'thesisadmin'
param vmSize string = 'Standard_F1as_v7'

resource hubVnet 'Microsoft.Network/virtualNetworks@2023-09-01' existing = {
  name: hubVnetName
}
resource firewall 'Microsoft.Network/azureFirewalls@2023-09-01' existing = {
  name: firewallName
}
resource firewallPolicy 'Microsoft.Network/firewallPolicies@2023-09-01' existing = {
  name: firewallPolicyName
}
// The workload uses the normal <account>.blob.core.windows.net endpoint.
// Link the existing Private Link zone so that hostname resolves to the
// private endpoint address from this spoke. The zone is created and populated
// by the private endpoint's DNS zone group in the shared hub resource group.
resource blobPrivateDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' existing = {
  name: 'privatelink.blob.${environment().suffixes.storage}'
}

var firewallPrivateIp = firewall.properties.ipConfigurations[0].properties.privateIPAddress
var returnRouteName = 'centralus-vm-p3-return-via-firewall'
var controllerRouteName = 'central-p3-subnet-via-firewall'

resource spokeVnet 'Microsoft.Network/virtualNetworks@2023-09-01' = {
  name: spokeVnetName
  location: location
  tags: {
    experimentRoute: 'azure_vm'
    experimentProfile: 'P3'
    networkIsolationValidated: 'false'
    hubVnet: hubVnetName
  }
  properties: {
    addressSpace: {
      addressPrefixes: [spokeAddressPrefix]
    }
  }
}

resource spokeRouteTable 'Microsoft.Network/routeTables@2023-09-01' = {
  name: routeTableName
  location: location
  properties: {
    disableBgpRoutePropagation: true
    routes: [
      {
        name: 'default-to-eastus-firewall'
        properties: {
          addressPrefix: '0.0.0.0/0'
          nextHopType: 'VirtualAppliance'
          nextHopIpAddress: firewallPrivateIp
        }
      }
      {
        name: 'hub-to-eastus-firewall'
        properties: {
          addressPrefix: '10.48.0.0/16'
          nextHopType: 'VirtualAppliance'
          nextHopIpAddress: firewallPrivateIp
        }
      }
    ]
  }
}

resource vmP3Subnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' = {
  parent: spokeVnet
  name: vmP3SubnetName
  properties: {
    addressPrefix: vmP3SubnetPrefix
    privateEndpointNetworkPolicies: 'Disabled'
    privateLinkServiceNetworkPolicies: 'Enabled'
    routeTable: {
      id: spokeRouteTable.id
    }
  }
}

resource spokePeering 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2023-09-01' = {
  parent: spokeVnet
  name: 'centralus-to-eastus-hub'
  properties: {
    remoteVirtualNetwork: {
      id: hubVnet.id
    }
    allowVirtualNetworkAccess: true
    allowForwardedTraffic: true
    allowGatewayTransit: false
    useRemoteGateways: false
  }
}

resource hubPeering 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2023-09-01' = {
  parent: hubVnet
  name: 'eastus-hub-to-centralus-p3'
  properties: {
    remoteVirtualNetwork: {
      id: spokeVnet.id
    }
    allowVirtualNetworkAccess: true
    allowForwardedTraffic: true
    allowGatewayTransit: false
    useRemoteGateways: false
  }
}

resource blobPrivateDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: blobPrivateDnsZone
  name: '${spokeVnetName}-blob'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: spokeVnet.id }
  }
}

resource vmP3CentralFirewallRules 'Microsoft.Network/firewallPolicies/ruleCollectionGroups@2023-09-01' = {
  parent: firewallPolicy
  name: 'vm-p3-centralus-selective-egress'
  properties: {
    // Existing groups are at 100, 200, and 300. Keep this spoke isolated in its
    // own group between the existing P3 and controller rule groups.
    priority: 220
    ruleCollections: [
      {
        name: 'vm-p3-centralus-controller-https'
        ruleCollectionType: 'FirewallPolicyFilterRuleCollection'
        priority: 100
        action: {
          type: 'Allow'
        }
        rules: [
          {
            ruleType: 'NetworkRule'
            name: 'allow-controller-https-to-centralus-p3'
            ipProtocols: ['TCP']
            sourceAddresses: controllerSourcePrefixes
            destinationAddresses: [vmP3SubnetPrefix]
            destinationPorts: ['443']
          }
        ]
      }
      {
        name: 'vm-p3-centralus-allow-controlled-destinations'
        ruleCollectionType: 'FirewallPolicyFilterRuleCollection'
        priority: 110
        action: {
          type: 'Allow'
        }
        rules: [
          {
            ruleType: 'NetworkRule'
            name: 'allow-centralus-p3-research-service'
            ipProtocols: ['TCP']
            sourceAddresses: [vmP3SubnetPrefix]
            destinationAddresses: [researchServicePrivateIp]
            destinationPorts: ['443']
          }
          {
            ruleType: 'NetworkRule'
            name: 'allow-centralus-p3-fixture-blob'
            ipProtocols: ['TCP']
            sourceAddresses: [vmP3SubnetPrefix]
            destinationAddresses: [fixtureBlobPrivateEndpointIp]
            destinationPorts: ['443']
          }
        ]
      }
      {
        name: 'vm-p3-centralus-deny-collector'
        ruleCollectionType: 'FirewallPolicyFilterRuleCollection'
        priority: 120
        action: {
          type: 'Deny'
        }
        rules: [
          {
            ruleType: 'NetworkRule'
            name: 'deny-centralus-p3-collector'
            ipProtocols: ['TCP', 'UDP']
            sourceAddresses: [vmP3SubnetPrefix]
            destinationAddresses: [collectorPrivateIp]
            destinationPorts: ['*']
          }
        ]
      }
      {
        name: 'vm-p3-centralus-deny-all-other-egress'
        ruleCollectionType: 'FirewallPolicyFilterRuleCollection'
        priority: 130
        action: {
          type: 'Deny'
        }
        rules: [
          {
            ruleType: 'NetworkRule'
            name: 'deny-centralus-p3-default'
            ipProtocols: ['Any']
            sourceAddresses: [vmP3SubnetPrefix]
            destinationAddresses: ['*']
            destinationPorts: ['*']
          }
        ]
      }
    ]
  }
}

resource serviceReturnRoutes 'Microsoft.Network/routeTables@2023-09-01' = {
  name: serviceReturnRouteTableName
  location: hubLocation
  properties: {
    disableBgpRoutePropagation: false
    routes: concat(
      filter(serviceReturnExistingRoutes, route => route.name != returnRouteName),
      [
        {
          name: returnRouteName
          properties: {
            addressPrefix: vmP3SubnetPrefix
            nextHopType: 'VirtualAppliance'
            nextHopIpAddress: firewallPrivateIp
          }
        }
      ]
    )
  }
}

resource privateEndpointReturnRoutes 'Microsoft.Network/routeTables@2023-09-01' = {
  name: privateEndpointReturnRouteTableName
  location: hubLocation
  properties: {
    disableBgpRoutePropagation: false
    routes: concat(
      filter(privateEndpointReturnExistingRoutes, route => route.name != returnRouteName),
      [
        {
          name: returnRouteName
          properties: {
            addressPrefix: vmP3SubnetPrefix
            nextHopType: 'VirtualAppliance'
            nextHopIpAddress: firewallPrivateIp
          }
        }
      ]
    )
  }
}

resource controllerReturnRoutes 'Microsoft.Network/routeTables@2023-09-01' = {
  name: controllerRouteTableName
  location: hubLocation
  tags: {
    Phase: 'NonCountedPilot'
    Role: 'Controller'
    Study: 'AzureThesisExperiment'
  }
  properties: {
    disableBgpRoutePropagation: true
    routes: concat(
      filter(controllerExistingRoutes, route => route.name != controllerRouteName),
      [
        {
          name: controllerRouteName
          properties: {
            addressPrefix: vmP3SubnetPrefix
            nextHopType: 'VirtualAppliance'
            nextHopIpAddress: firewallPrivateIp
          }
        }
      ]
    )
  }
}

module p3Workload './vm-route.bicep' = {
  name: 'centralus-p3-workload-route'
  params: {
    location: location
    vmName: vmName
    profile: 'P3'
    subnetId: vmP3Subnet.id
    workloadIdentityName: workloadIdentityName
    controllerSourcePrefixes: controllerSourcePrefixes
    sshPublicKey: sshPublicKey
    adminUsername: adminUsername
    vmSize: vmSize
    imageVersion: imageVersion
  }
  dependsOn: [
    hubPeering
    spokePeering
    blobPrivateDnsLink
    vmP3CentralFirewallRules
    serviceReturnRoutes
    privateEndpointReturnRoutes
    controllerReturnRoutes
  ]
}

output spokeVnetId string = spokeVnet.id
output p3SubnetId string = vmP3Subnet.id
output routeTableId string = spokeRouteTable.id
output controllerRouteTableId string = controllerReturnRoutes.id
output hubFirewallIp string = firewallPrivateIp
output p3VmId string = p3Workload.outputs.vmId
output p3VmPublicIp string = 'none'
