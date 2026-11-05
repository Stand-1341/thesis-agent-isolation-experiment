// Per-profile private VM workload route. This module attaches one actual UAI,
// provides narrowly scoped inbound reachability from the experiment controller,
// and has no public IP. It does not provision the workload software, TLS proxy,
// a controller VPN/private route, or P3 egress enforcement. For P3, a separately
// reviewed egress policy and independently attributed deny evidence are required.
param location string = resourceGroup().location
@minLength(1)
@maxLength(50)
param vmName string
@allowed([
  'P1'
  'P2'
  'P3'
])
param profile string
@description('Full resource ID of this route\'s dedicated VM subnet.')
param subnetId string
@description('Name of the pre-created user-assigned identity assigned to this route.')
param workloadIdentityName string
@description('Exact private CIDRs from the controller network, reachable through an existing VPN or private route.')
@minLength(1)
param controllerSourcePrefixes array
@description('SSH public key only; never pass a private key.')
param sshPublicKey string
@minLength(1)
@maxLength(32)
param adminUsername string = 'thesisadmin'
@description('Candidate size; verify regional quota, availability, and current cost before deployment.')
param vmSize string = 'Standard_F1as_v7'
@description('Exact Ubuntu image version; resolve and record before deployment.')
param imageVersion string

resource workloadIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: workloadIdentityName
}

resource routeNsg 'Microsoft.Network/networkSecurityGroups@2023-09-01' = {
  name: '${vmName}-route-nsg'
  location: location
  tags: {
    experimentRoute: 'azure_vm'
    experimentProfile: profile
    networkIsolationValidated: 'false'
  }
  properties: {
    securityRules: [
      {
        name: 'controller-https'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefixes: controllerSourcePrefixes
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '443'
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

resource nic 'Microsoft.Network/networkInterfaces@2023-09-01' = {
  name: '${vmName}-nic'
  location: location
  properties: {
    networkSecurityGroup: { id: routeNsg.id }
    ipConfigurations: [
      {
        name: 'primary'
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          subnet: { id: subnetId }
        }
      }
    ]
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2023-09-01' = {
  name: vmName
  location: location
  tags: {
    experimentRoute: 'azure_vm'
    experimentProfile: profile
    role: 'workload-route'
    networkIsolationValidated: 'false'
  }
  identity: {
    type: 'SystemAssigned, UserAssigned'
    userAssignedIdentities: {
      '${workloadIdentity.id}': {}
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
      computerName: vmName
      adminUsername: adminUsername
      linuxConfiguration: {
        disablePasswordAuthentication: true
        ssh: { publicKeys: [{ path: '/home/${adminUsername}/.ssh/authorized_keys', keyData: sshPublicKey }] }
      }
    }
    networkProfile: { networkInterfaces: [{ id: nic.id }] }
  }
}

output vmId string = vm.id
output networkInterfaceId string = nic.id
output workloadPrincipalId string = workloadIdentity.properties.principalId
output workloadIdentityClientId string = workloadIdentity.properties.clientId
output systemPrincipalId string = vm.identity.principalId
output profile string = profile
