// Incomplete pilot module: no public IP, software deployment, or P3 proof.
// Deploy only into a separately prepared, controlled subnet after readiness review.
param location string = resourceGroup().location
@minLength(1)
@maxLength(50)
param vmName string
@description('Full resource ID of an existing pilot subnet.')
param subnetId string
@description('SSH public key only; never pass a private key.')
param sshPublicKey string
@minLength(1)
@maxLength(32)
param adminUsername string = 'thesisadmin'
@description('Candidate size; actual quota and capacity must be checked.')
param vmSize string = 'Standard_F1as_v7'
@description('Exact Ubuntu image version; resolve and record before deployment.')
param imageVersion string
@description('Optional separately validated NIC-level NSG resource ID.')
param networkSecurityGroupId string = ''

resource nic 'Microsoft.Network/networkInterfaces@2023-09-01' = {
  name: '${vmName}-nic'
  location: location
  properties: {
    networkSecurityGroup: empty(networkSecurityGroupId) ? null : { id: networkSecurityGroupId }
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
  identity: { type: 'SystemAssigned' }
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
output workloadPrincipalId string = vm.identity.principalId
