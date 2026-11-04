// Dedicated temporary experiment controller for non-counted pilot runs.
// It is not a measured-study readiness declaration: verify route identities,
// private endpoint reachability, firewall deny logs, and evidence protection
// before using trial results. It never attaches to or changes sessions-pilot.
param location string = resourceGroup().location
param vnetName string
param firewallName string
param firewallPolicyName string
param researchNsgName string
@minLength(3)
@maxLength(50)
param controllerName string
param controllerIdentityName string = 'id-thesis-fixture-controller'
param auditIdentityName string = 'id-thesis-audit-verifier'
param sessionIdentityName string = 'id-thesis-session-reader'
param acrPullIdentityName string = 'id-thesis-acr-pull'
@description('Existing private ACR registry used to distribute the runner image.')
param sessionRegistryStorageAccountName string = 'thesispilotblob20261102'
@description('New, unused range in the existing VNet. Keep this separate from sessions-pilot.')
param controllerSubnetPrefix string = '10.48.11.0/24'
param researchServicePrivateIp string = '10.48.9.4'
param collectorPrivateIp string = '10.48.9.5'
param researchServicePort int = 443
param collectorPort int = 8443
@description('Exact FQDNs required by the selected pilot routes and Entra/Log Analytics. Do not use wildcard entries.')
@minLength(1)
param allowedApplicationFqdns array
param vmSize string = 'Standard_F1as_v7'
@description('An exact, available Ubuntu 22.04 Gen2 image version. Resolve before deployment.')
param imageVersion string
param adminUsername string = 'thesisadmin'
@description('SSH public key; no SSH ingress is opened. Azure Run Command is the intended operator path.')
param sshPublicKey string
param tags object = { Study: 'AzureThesisExperiment', Phase: 'NonCountedPilot', Role: 'Controller' }

resource vnet 'Microsoft.Network/virtualNetworks@2023-09-01' existing = { name: vnetName }
resource firewall 'Microsoft.Network/azureFirewalls@2023-09-01' existing = { name: firewallName }
resource firewallPolicy 'Microsoft.Network/firewallPolicies@2023-09-01' existing = { name: firewallPolicyName }
resource researchNsg 'Microsoft.Network/networkSecurityGroups@2023-09-01' existing = { name: researchNsgName }
resource controllerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: controllerIdentityName }
resource auditIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: auditIdentityName }
resource sessionIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: sessionIdentityName }
resource acrPullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: acrPullIdentityName }
resource sessionRegistryAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = { name: sessionRegistryStorageAccountName }
resource sessionRegistryBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: sessionRegistryAccount
  name: 'default'
}
resource sessionRegistryContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = {
  parent: sessionRegistryBlobService
  name: 'session-mappings'
}

resource sessionRegistryWriterRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: sessionRegistryContainer
  name: guid(sessionRegistryContainer.id, controllerIdentity.id, 'controller-session-mapping-writer')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalId: controllerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
resource controllerNsg 'Microsoft.Network/networkSecurityGroups@2023-09-01' = {
  name: '${controllerName}-nsg'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'deny-all-inbound'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
      {
        name: 'allow-dns-outbound'
        properties: {
          priority: 100
          direction: 'Outbound'
          access: 'Allow'
          protocol: '*'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '168.63.129.16'
          destinationPortRanges: [ '53' ]
        }
      }
      {
        name: 'allow-https-to-firewall-policy'
        properties: {
          priority: 110
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '443'
        }
      }
      {
        name: 'allow-collector-api-via-firewall'
        properties: {
          priority: 115
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: controllerSubnetPrefix
          sourcePortRange: '*'
          destinationAddressPrefix: collectorPrivateIp
          destinationPortRange: '8443'
        }
      }
      {
        name: 'deny-other-outbound'
        properties: {
          priority: 4000
          direction: 'Outbound'
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

resource controllerRouteTable 'Microsoft.Network/routeTables@2023-09-01' = {
  name: '${controllerName}-routes'
  location: location
  tags: tags
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
    ]
  }
}

resource controllerSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' = {
  parent: vnet
  name: 'experiment-controller'
  properties: {
    addressPrefix: controllerSubnetPrefix
    networkSecurityGroup: { id: controllerNsg.id }
    routeTable: { id: controllerRouteTable.id }
  }
}

resource allowResearchFromController 'Microsoft.Network/networkSecurityGroups/securityRules@2023-09-01' = {
  parent: researchNsg
  name: 'controller-pilot-research-https'
  properties: {
    priority: 125
    direction: 'Inbound'
    access: 'Allow'
    protocol: 'Tcp'
    sourceAddressPrefix: controllerSubnetPrefix
    sourcePortRange: '*'
    destinationAddressPrefix: researchServicePrivateIp
    destinationPortRange: string(researchServicePort)
  }
}
resource allowCollectorFromController 'Microsoft.Network/networkSecurityGroups/securityRules@2023-09-01' = {
  parent: researchNsg
  name: 'controller-pilot-collector-https'
  properties: {
    priority: 135
    direction: 'Inbound'
    access: 'Allow'
    protocol: 'Tcp'
    sourceAddressPrefix: controllerSubnetPrefix
    sourcePortRange: '*'
    destinationAddressPrefix: collectorPrivateIp
    destinationPortRange: string(collectorPort)
  }
}

resource controllerEgressRules 'Microsoft.Network/firewallPolicies/ruleCollectionGroups@2023-09-01' = {
  parent: firewallPolicy
  name: '${controllerName}-egress'
  properties: {
    priority: 300
    ruleCollections: [
      {
        name: 'controller-public-https'
        ruleCollectionType: 'FirewallPolicyFilterRuleCollection'
        priority: 110
        action: { type: 'Allow' }
        rules: [
          {
            ruleType: 'ApplicationRule'
            name: 'exact-required-fqdns'
            sourceAddresses: [ controllerSubnetPrefix ]
            protocols: [ { protocolType: 'Https', port: 443 } ]
            targetFqdns: allowedApplicationFqdns
          }
        ]
      }
    ]
  }
}

resource controllerVm 'Microsoft.Compute/virtualMachines@2023-09-01' = {
  name: controllerName
  location: location
  tags: union(tags, { networkIsolationValidated: 'false' })
  identity: {
    type: 'SystemAssigned, UserAssigned'
    userAssignedIdentities: {
      '${controllerIdentity.id}': {}
      '${auditIdentity.id}': {}
      '${sessionIdentity.id}': {}
      '${acrPullIdentity.id}': {}
    }
  }
  properties: {
    hardwareProfile: { vmSize: vmSize }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: '0001-com-ubuntu-server-jammy'
        sku: '22_04-lts-gen2'
        version: imageVersion
      }
      osDisk: {
        createOption: 'FromImage'
        managedDisk: { storageAccountType: 'StandardSSD_LRS' }
      }
    }
    osProfile: {
      computerName: controllerName
      adminUsername: adminUsername
      linuxConfiguration: {
        disablePasswordAuthentication: true
        ssh: { publicKeys: [ { path: '/home/${adminUsername}/.ssh/authorized_keys', keyData: sshPublicKey } ] }
      }
    }
    networkProfile: { networkInterfaces: [ { id: controllerNic.id } ] }
  }
  dependsOn: [ controllerEgressRules, allowResearchFromController, allowCollectorFromController ]
}

resource controllerNic 'Microsoft.Network/networkInterfaces@2023-09-01' = {
  name: '${controllerName}-nic'
  location: location
  tags: tags
  properties: {
    ipConfigurations: [
      {
        name: 'primary'
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          subnet: { id: controllerSubnet.id }
        }
      }
    ]
  }
}

output controllerId string = controllerVm.id
output controllerPrivateIp string = controllerNic.properties.ipConfigurations[0].properties.privateIPAddress
output controllerSystemPrincipalId string = controllerVm.identity.principalId
output controllerIdentityClientId string = controllerIdentity.properties.clientId
output auditIdentityClientId string = auditIdentity.properties.clientId
output sessionIdentityClientId string = sessionIdentity.properties.clientId
output acrPullIdentityClientId string = acrPullIdentity.properties.clientId
output controllerSubnetId string = controllerSubnet.id
output controllerFirewallPrivateIp string = firewall.properties.ipConfigurations[0].properties.privateIPAddress
