// Candidate regional P3 enforcement spoke. It provisions the P3 network
// boundary, VM, ACA Jobs environment/job, and SandboxGroup, and declares hub
// connectivity. It is NOT deployed or pilot-validated; see
// docs/MULTI-REGION-DEPLOYMENT-DESIGN.md.
targetScope = 'resourceGroup'

@minLength(3)
@maxLength(12)
param namePrefix string

@description('Owner-selected non-East-US region. Region availability/quota must be independently verified before deployment.')
param location string

param tags object = {
  Study: 'AzureThesisExperiment'
  Phase: 'MultiRegionP3Candidate'
}

@description('Non-overlapping address space dedicated to this regional P3 spoke.')
param vnetAddressPrefix string

@description('Dedicated P3 VM subnet CIDR.')
param vmP3SubnetPrefix string

@minLength(9)
@description('Dedicated /27-or-larger subnet delegated to Microsoft.App/environments for the isolated P3 ACA Jobs environment.')
param jobsP3EnvironmentSubnetPrefix string

@description('AzureFirewallSubnet CIDR; must be at least /26.')
param firewallSubnetPrefix string

@description('AzureFirewallManagementSubnet CIDR; must be at least /26 for Basic firewall management configuration.')
param firewallManagementSubnetPrefix string

@description('Trusted controller source CIDRs allowed to reach the P3 VM agent over HTTPS. Empty is rejected by minItems.')
@minLength(1)
param controllerSourcePrefixes array

@description('Private IP of the shared research endpoint reachable from this region after approved hub connectivity is configured.')
param researchServicePrivateIp string

@minValue(1)
@maxValue(65535)
param researchServicePort int = 443

@description('Private IP of the shared collector endpoint. This address is explicitly denied from P3 sources.')
param collectorPrivateIp string

@description('Private IP of the independent restricted receiver. U7 sends are explicitly denied by the regional P3 firewall.')
param restrictedServicePrivateIp string

@description('Private endpoint IP of the shared synthetic fixture Blob account.')
param fixtureEndpointPrivateIp string

@description('Private endpoint IP of the protected evidence account, if workloads must reach it. Evidence writers should normally be separate controller identities.')
param evidenceEndpointPrivateIp string = ''

@description('Existing Log Analytics workspace resource ID for regional firewall diagnostics.')
param logAnalyticsWorkspaceId string

@description('Optional resource ID of the shared-services hub VNet. When provided, this module creates the P3 spoke side of global VNet peering. The hub-side reciprocal peering and reviewed return routes remain an explicit owner step.')
param sharedHubVnetResourceId string = ''

@description('Optional resource ID of the shared-services subnet route table. When supplied, explicit return routes for both P3 subnets are added through this spoke firewall.')
param sharedHubRouteTableResourceId string = ''
@description('Optional resource ID of the shared private-endpoint subnet route table. When supplied, P3 return routes are added through this spoke firewall too.')
param sharedHubPrivateEndpointRouteTableResourceId string = ''

@description('Private DNS zone resource IDs required by shared study services. Links are created with registration disabled.')
param sharedPrivateDnsZoneResourceIds array = []

@description('Additional platform FQDNs required by the ACA runtime; reviewed allowlist entries only.')
param platformAllowExtraFqdns array = []

@description('Platform service tags required by the ACA workload profile.')
param platformAllowServiceTags array = [
  'MicrosoftContainerRegistry'
  'AzureFrontDoorFirstParty'
  'AzureContainerRegistry'
  'AzureActiveDirectory'
  'AzureKeyVault'
]

@description('Exact private ACR login FQDN used by the workload-profile environment. Use the registry private endpoint and its private DNS path; do not pass a broad storage wildcard.')
param registryFqdn string

@description('Existing shared Log Analytics workspace resource ID used by the isolated regional P3 Jobs environment.')
param logWorkspaceResourceId string

@description('Pinned P3 agent container image reference.')
param agentImageP3 string

@description('Existing P3 VM workload UAI name in this resource group.')
param vmWorkloadIdentityName string
@description('Existing P3 VM secret-reader UAI name in this resource group.')
param vmReaderUaiName string
@description('Existing P3 Jobs workload UAI resource ID.')
param jobsWorkloadIdentityResourceId string
@description('Existing P3 Jobs workload UAI client ID.')
param jobsWorkloadIdentityClientId string
@description('Existing P3 Jobs workload UAI principal ID.')
param jobsWorkloadPrincipalId string
@description('Existing P3 Jobs route secret-reader UAI resource ID.')
param jobsReaderIdentityResourceId string
@description('Existing P3 Jobs route secret-reader UAI client ID.')
param jobsReaderIdentityClientId string
@description('Existing ACR pull UAI resource ID.')
param imagePullIdentityResourceId string
@description('Existing P3 SandboxGroup control identity resource ID.')
param sandboxControlIdentityResourceId string
@description('Existing P3 SandboxGroup control identity principal ID.')
param sandboxControlPrincipalId string
@description('Pinned Ubuntu image version for the P3 VM route.')
param vmImageVersion string
@description('SSH public key for the P3 VM route.')
param sshPublicKey string
@description('P3 VM size.')
param vmSize string = 'Standard_F1as_v7'

var firewallName = '${namePrefix}-p3-fw'
var firewallPolicyName = '${namePrefix}-p3-fw-policy'
var vmNsgName = '${namePrefix}-p3-vm-nsg'
var egressRouteTableName = '${namePrefix}-p3-egress-rt'
var loginHost = split(replace(environment().authentication.loginEndpoint, 'https://', ''), '/')[0]
var loginMicrosoftHost = replace(loginHost, 'microsoftonline', 'microsoft')
var platformFqdns = concat(platformAllowExtraFqdns, [
  'mcr.microsoft.com'
  '*.data.mcr.microsoft.com'
  'packages.aks.azure.com'
  'acs-mirror.azureedge.net'
  '*.identity.azure.net'
  loginHost
  '*.${loginHost}'
  loginMicrosoftHost
  '*.${loginMicrosoftHost}'
])

resource vnet 'Microsoft.Network/virtualNetworks@2023-09-01' = {
  name: '${namePrefix}-p3-vnet'
  location: location
  tags: tags
  properties: { addressSpace: { addressPrefixes: [vnetAddressPrefix] } }
}

resource sharedHubPeering 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2023-09-01' = if (!empty(sharedHubVnetResourceId)) {
  parent: vnet
  name: 'to-shared-services-hub'
  properties: {
    remoteVirtualNetwork: { id: sharedHubVnetResourceId }
    allowVirtualNetworkAccess: true
    allowForwardedTraffic: true
    allowGatewayTransit: false
    useRemoteGateways: false
  }
}

// Create the reciprocal side when the hub is supplied. Both peerings are
// global-capable and permit forwarding so the spoke firewall remains the
// regional enforcement point for traffic sent to shared services.
module reciprocalHubPeering './hub-p3-peering.bicep' = if (!empty(sharedHubVnetResourceId)) {
  name: '${namePrefix}-p3-hub-peering'
  scope: resourceGroup(split(sharedHubVnetResourceId, '/')[2], split(sharedHubVnetResourceId, '/')[4])
  params: {
    hubVnetName: last(split(sharedHubVnetResourceId, '/'))
    spokeVnetResourceId: vnet.id
    peeringName: '${namePrefix}-p3-spoke'
  }
}

module sharedHubReturnRoutes './hub-p3-return-routes.bicep' = if (!empty(sharedHubRouteTableResourceId)) {
  name: '${namePrefix}-p3-hub-return-routes'
  scope: resourceGroup(split(sharedHubRouteTableResourceId, '/')[2], split(sharedHubRouteTableResourceId, '/')[4])
  params: {
    routeTableName: last(split(sharedHubRouteTableResourceId, '/'))
    namePrefix: namePrefix
    vmP3SubnetPrefix: vmP3SubnetPrefix
    jobsP3EnvironmentSubnetPrefix: jobsP3EnvironmentSubnetPrefix
    firewallPrivateIp: firewallPrivateIp
  }
}

module sharedHubPrivateEndpointReturnRoutes './hub-p3-return-routes.bicep' = if (!empty(sharedHubPrivateEndpointRouteTableResourceId)) {
  name: '${namePrefix}-p3-hub-pe-return-routes'
  scope: resourceGroup(split(sharedHubPrivateEndpointRouteTableResourceId, '/')[2], split(sharedHubPrivateEndpointRouteTableResourceId, '/')[4])
  params: {
    routeTableName: last(split(sharedHubPrivateEndpointRouteTableResourceId, '/'))
    namePrefix: '${namePrefix}-pe'
    vmP3SubnetPrefix: vmP3SubnetPrefix
    jobsP3EnvironmentSubnetPrefix: jobsP3EnvironmentSubnetPrefix
    firewallPrivateIp: firewallPrivateIp
  }
}

module sharedDnsLinks './regional-p3-private-dns-link.bicep' = [for (zoneId, index) in sharedPrivateDnsZoneResourceIds: {
  name: '${namePrefix}-p3-dns-link-${index}'
  scope: resourceGroup(split(zoneId, '/')[2], split(zoneId, '/')[4])
  params: {
    privateDnsZoneName: last(split(zoneId, '/'))
    virtualNetworkId: vnet.id
    linkName: '${namePrefix}-p3-${uniqueString(vnet.id, zoneId)}'
  }
}]

resource firewallSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' = {
  parent: vnet
  name: 'AzureFirewallSubnet'
  properties: { addressPrefix: firewallSubnetPrefix }
}

resource firewallManagementSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' = {
  parent: vnet
  name: 'AzureFirewallManagementSubnet'
  dependsOn: [firewallSubnet]
  properties: { addressPrefix: firewallManagementSubnetPrefix }
}

resource vmNsg 'Microsoft.Network/networkSecurityGroups@2023-09-01' = {
  name: vmNsgName
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'allow-controller-https'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          sourceAddressPrefixes: controllerSourcePrefixes
          destinationAddressPrefix: '*'
          destinationPortRange: '443'
        }
      }
      {
        name: 'deny-all-other-inbound'
        properties: {
          priority: 4096
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourcePortRange: '*'
          sourceAddressPrefix: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

resource vmP3Subnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' = {
  parent: vnet
  name: 'vm-p3'
  properties: {
    addressPrefix: vmP3SubnetPrefix
    routeTable: { id: egressRouteTable.id }
    networkSecurityGroup: { id: vmNsg.id }
  }
}

// ACA subnet has the documented delegation and UDR. No NSG is attached here:
// ACA platform networking has additional required flows; the firewall is the
// P3 egress boundary and ACA NSG policy requires separate pilot validation.
resource jobsP3Subnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' = {
  parent: vnet
  name: 'jobs-p3'
  dependsOn: [vmP3Subnet]
  properties: {
    addressPrefix: jobsP3EnvironmentSubnetPrefix
    delegations: [
      { name: 'container-apps-environment', properties: { serviceName: 'Microsoft.App/environments' } }
    ]
    routeTable: { id: egressRouteTable.id }
  }
}

module p3Vm './vm-route.bicep' = {
  name: '${namePrefix}-regional-vm-p3'
  params: {
    location: location
    vmName: '${namePrefix}-vm-p3'
    profile: 'P3'
    subnetId: vmP3Subnet.id
    workloadIdentityName: vmWorkloadIdentityName
    readerUaiName: vmReaderUaiName
    controllerSourcePrefixes: controllerSourcePrefixes
    sshPublicKey: sshPublicKey
    imageVersion: vmImageVersion
    vmSize: vmSize
  }
}

resource firewallPublicIp 'Microsoft.Network/publicIPAddresses@2023-09-01' = {
  name: '${namePrefix}-p3-fw-pip'
  location: location
  sku: { name: 'Standard', tier: 'Regional' }
  properties: { publicIPAllocationMethod: 'Static' }
}

resource firewallManagementPublicIp 'Microsoft.Network/publicIPAddresses@2023-09-01' = {
  name: '${namePrefix}-p3-fw-mgmt-pip'
  location: location
  sku: { name: 'Standard', tier: 'Regional' }
  properties: { publicIPAllocationMethod: 'Static' }
}

resource firewallPolicy 'Microsoft.Network/firewallPolicies@2023-09-01' = {
  name: firewallPolicyName
  location: location
  tags: tags
  properties: { sku: { tier: 'Basic' }, threatIntelMode: 'Alert' }
}

resource platformRules 'Microsoft.Network/firewallPolicies/ruleCollectionGroups@2023-09-01' = {
  parent: firewallPolicy
  name: 'required-platform-egress'
  properties: {
    priority: 100
    ruleCollections: [
      {
        name: 'platform-required-https'
        ruleCollectionType: 'FirewallPolicyFilterRuleCollection'
        priority: 100
        action: { type: 'Allow' }
        rules: [
          {
            ruleType: 'ApplicationRule'
            name: 'container-apps-platform'
            sourceAddresses: [vmP3SubnetPrefix, jobsP3EnvironmentSubnetPrefix]
            protocols: [{ protocolType: 'Https', port: 443 }]
          targetFqdns: concat(platformFqdns, [registryFqdn])
          }
        ]
      }
      {
        name: 'platform-required-network'
        ruleCollectionType: 'FirewallPolicyFilterRuleCollection'
        priority: 110
        action: { type: 'Allow' }
        rules: [
          {
            ruleType: 'NetworkRule'
            name: 'platform-service-tags'
            ipProtocols: ['TCP']
            sourceAddresses: [vmP3SubnetPrefix, jobsP3EnvironmentSubnetPrefix]
            destinationAddresses: platformAllowServiceTags
            destinationPorts: ['443']
          }
          {
            ruleType: 'NetworkRule'
            name: 'azure-platform-dns'
            ipProtocols: ['TCP', 'UDP']
            sourceAddresses: [vmP3SubnetPrefix, jobsP3EnvironmentSubnetPrefix]
            destinationAddresses: ['AzurePlatformDNS']
            destinationPorts: ['53']
          }
        ]
      }
    ]
  }
}

resource studyEgressRules 'Microsoft.Network/firewallPolicies/ruleCollectionGroups@2023-09-01' = {
  parent: firewallPolicy
  name: 'p3-selective-egress'
  dependsOn: [platformRules]
  properties: {
    priority: 200
    ruleCollections: [
      {
        name: 'p3-deny-restricted-collector'
        ruleCollectionType: 'FirewallPolicyFilterRuleCollection'
        priority: 100
        action: { type: 'Deny' }
        rules: [
          {
            ruleType: 'NetworkRule'
            name: 'p3-deny-collector'
            ipProtocols: ['TCP', 'UDP']
            sourceAddresses: [vmP3SubnetPrefix, jobsP3EnvironmentSubnetPrefix]
            destinationAddresses: [collectorPrivateIp]
            destinationPorts: ['*']
          }
        ]
      }
      {
        name: 'p3-deny-restricted-receiver'
        ruleCollectionType: 'FirewallPolicyFilterRuleCollection'
        priority: 110
        action: { type: 'Deny' }
        rules: [
          {
            ruleType: 'NetworkRule'
            name: 'p3-deny-restricted-service'
            ipProtocols: ['TCP', 'UDP']
            sourceAddresses: [vmP3SubnetPrefix, jobsP3EnvironmentSubnetPrefix]
            destinationAddresses: [restrictedServicePrivateIp]
            destinationPorts: ['*']
          }
        ]
      }
      {
        name: 'p3-allow-controlled-destinations'
        ruleCollectionType: 'FirewallPolicyFilterRuleCollection'
        priority: 200
        action: { type: 'Allow' }
        rules: concat([
          {
            ruleType: 'NetworkRule'
            name: 'p3-allow-research-service'
            ipProtocols: ['TCP']
            sourceAddresses: [vmP3SubnetPrefix, jobsP3EnvironmentSubnetPrefix]
            destinationAddresses: [researchServicePrivateIp]
            destinationPorts: [string(researchServicePort)]
          }
          {
            ruleType: 'NetworkRule'
            name: 'p3-allow-fixture-blob'
            ipProtocols: ['TCP']
            sourceAddresses: [vmP3SubnetPrefix, jobsP3EnvironmentSubnetPrefix]
            destinationAddresses: [fixtureEndpointPrivateIp]
            destinationPorts: ['443']
          }
        ], empty(evidenceEndpointPrivateIp) ? [] : [
          {
            ruleType: 'NetworkRule'
            name: 'p3-allow-evidence-blob'
            ipProtocols: ['TCP']
            sourceAddresses: [vmP3SubnetPrefix, jobsP3EnvironmentSubnetPrefix]
            destinationAddresses: [evidenceEndpointPrivateIp]
            destinationPorts: ['443']
          }
        ])
      }
      {
        name: 'p3-deny-all-other-egress'
        ruleCollectionType: 'FirewallPolicyFilterRuleCollection'
        priority: 300
        action: { type: 'Deny' }
        rules: [
          {
            ruleType: 'NetworkRule'
            name: 'p3-default-deny'
            ipProtocols: ['Any']
            sourceAddresses: [vmP3SubnetPrefix, jobsP3EnvironmentSubnetPrefix]
            destinationAddresses: ['*']
            destinationPorts: ['*']
          }
        ]
      }
    ]
  }
}

resource firewall 'Microsoft.Network/azureFirewalls@2023-09-01' = {
  name: firewallName
  location: location
  tags: tags
  dependsOn: [studyEgressRules]
  properties: {
    sku: { name: 'AZFW_VNet', tier: 'Basic' }
    firewallPolicy: { id: firewallPolicy.id }
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

resource firewallDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: firewall
  name: 'p3-egress-audit'
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      { category: 'AzureFirewallApplicationRule', enabled: true }
      { category: 'AzureFirewallNetworkRule', enabled: true }
    ]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

var firewallPrivateIp = firewall.properties.ipConfigurations[0].properties.privateIPAddress

resource egressRouteTable 'Microsoft.Network/routeTables@2023-09-01' = {
  name: egressRouteTableName
  location: location
  tags: tags
  properties: {
    disableBgpRoutePropagation: true
    routes: [
      { name: 'default-to-firewall', properties: { addressPrefix: '0.0.0.0/0', nextHopType: 'VirtualAppliance', nextHopIpAddress: firewallPrivateIp } }
      { name: 'vnet-to-firewall', properties: { addressPrefix: vnetAddressPrefix, nextHopType: 'VirtualAppliance', nextHopIpAddress: firewallPrivateIp } }
    ]
  }
}

resource logWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: last(split(logWorkspaceResourceId, '/'))
  scope: resourceGroup(split(logWorkspaceResourceId, '/')[2], split(logWorkspaceResourceId, '/')[4])
}

resource jobsEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${namePrefix}-jobs-p3-env'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: { customerId: logWorkspace.properties.customerId, sharedKey: logWorkspace.listKeys().primarySharedKey }
    }
    vnetConfiguration: { infrastructureSubnetId: jobsP3Subnet.id, internal: false }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
  }
}

resource jobP3 'Microsoft.App/jobs@2026-07-01' = {
  name: '${namePrefix}-job-p3'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${jobsWorkloadIdentityResourceId}': {}
      '${jobsReaderIdentityResourceId}': {}
    }
  }
  properties: {
    environmentId: jobsEnvironment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaRetryLimit: 0
      replicaTimeout: 1800
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: [{ server: registryFqdn, identity: imagePullIdentityResourceId }]
    }
    template: {
      containers: [{
        name: 'agent-runner'
        image: agentImageP3
        command: ['node', 'dist/agent-runner.js']
        env: [
          { name: 'SCENARIO_PROFILE', value: 'P3' }
          { name: 'AZURE_CLIENT_ID', value: jobsWorkloadIdentityClientId }
          { name: 'THESIS_SECRET_READER_CLIENT_ID', value: jobsReaderIdentityClientId }
        ]
        resources: { cpu: 1, memory: '2Gi' }
      }]
    }
  }
  dependsOn: [studyEgressRules]
}

resource sandboxGroupP3 'Microsoft.App/sandboxGroups@2026-07-01' = {
  name: '${namePrefix}-sg-p3'
  location: location
  tags: tags
  properties: { environmentId: jobsEnvironment.id }
}

resource sandboxGroupP3DataOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(sandboxGroupP3.id, sandboxControlIdentityResourceId, 'c24cf47c-5077-412d-a19c-45202126392c')
  scope: sandboxGroupP3
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'c24cf47c-5077-412d-a19c-45202126392c')
    principalId: sandboxControlPrincipalId
    principalType: 'ServicePrincipal'
  }
}

output region string = location
output vnetId string = vnet.id
output vnetAddressPrefix string = vnetAddressPrefix
output vmP3SubnetId string = vmP3Subnet.id
output vmP3SubnetPrefix string = vmP3SubnetPrefix
output jobsP3EnvironmentSubnetId string = jobsP3Subnet.id
output jobsP3EnvironmentSubnetPrefix string = jobsP3EnvironmentSubnetPrefix
output jobsP3EnvironmentId string = jobsEnvironment.id
output jobP3ResourceId string = jobP3.id
output jobP3WorkloadObjectId string = jobsWorkloadPrincipalId
output sandboxGroupP3ResourceId string = sandboxGroupP3.id
output vmP3ResourceId string = p3Vm.outputs.vmId
output vmP3WorkloadObjectId string = p3Vm.outputs.workloadPrincipalId
output firewallId string = firewall.id
output firewallPrivateIp string = firewallPrivateIp
output firewallPublicIp string = firewallPublicIp.properties.ipAddress
output egressRouteTableId string = egressRouteTable.id
output sharedHubPeeringId string = empty(sharedHubVnetResourceId) ? '' : sharedHubPeering!.id
output reciprocalHubPeeringId string = empty(sharedHubVnetResourceId) ? '' : reciprocalHubPeering!.outputs.peeringId
output sharedHubRouteTableId string = sharedHubRouteTableResourceId
output requiredSharedHubRoutes array = [
  { destination: vmP3SubnetPrefix, nextHopType: 'VirtualAppliance', nextHopIpAddress: firewallPrivateIp }
  { destination: jobsP3EnvironmentSubnetPrefix, nextHopType: 'VirtualAppliance', nextHopIpAddress: firewallPrivateIp }
]
output sharedPrivateDnsZoneLinked bool = length(sharedPrivateDnsZoneResourceIds) > 0
output sharedPrivateDnsZoneLinkIds array = [for (zoneId, index) in sharedPrivateDnsZoneResourceIds: sharedDnsLinks[index].outputs.linkId]
output connectivityNotes array = [
  'If sharedHubVnetResourceId is supplied, both global VNet peering resources are declared; the owner must approve the reciprocal peering in the hub subscription.'
  'Private DNS zones are linked only when their resource IDs are supplied; verify resolution from each workload route.'
  'If sharedHubRouteTableResourceId is supplied, the two explicit P3 return routes point to the regional firewall; review route-table association and existing prefixes before deployment.'
  'Do not claim shared-service reachability until regional non-counted pilot probes pass.'
]
