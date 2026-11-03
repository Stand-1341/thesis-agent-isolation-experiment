// Candidate private research/collector host. No software, TLS, disk formatting,
// external audit protection, P3 enforcement, or controller connectivity is installed.
param location string = resourceGroup().location
@minLength(1)
@maxLength(40)
param hostName string
@description('Dedicated research-services subnet resource ID.')
param subnetId string
@description('Exact trusted workload subnet CIDRs, supplied after network review.')
@minLength(1)
param workloadSourcePrefixes array
@description('Exact operator/controller CIDRs with a working private route; not workload CIDRs.')
@minLength(1)
param operatorSourcePrefixes array
param sshPublicKey string
param imageVersion string
param adminUsername string = 'thesisadmin'
param vmSize string = 'Standard_F1as_v7'

resource hostNsg 'Microsoft.Network/networkSecurityGroups@2023-09-01' = {
  name: '${hostName}-nsg'
  location: location
  properties: {
    securityRules: [
      { name: 'research-https', properties: { priority: 100, direction: 'Inbound', access: 'Allow', protocol: 'Tcp', sourceAddressPrefixes: workloadSourcePrefixes, sourcePortRange: '*', destinationAddressPrefix: '*', destinationPortRange: '443' } }
      { name: 'collector-https', properties: { priority: 110, direction: 'Inbound', access: 'Allow', protocol: 'Tcp', sourceAddressPrefixes: workloadSourcePrefixes, sourcePortRange: '*', destinationAddressPrefix: '*', destinationPortRange: '8443' } }
      { name: 'operator-services', properties: { priority: 120, direction: 'Inbound', access: 'Allow', protocol: 'Tcp', sourceAddressPrefixes: operatorSourcePrefixes, sourcePortRange: '*', destinationAddressPrefix: '*', destinationPortRanges: ['22', '443', '8443'] } }
      { name: 'deny-other-inbound', properties: { priority: 4000, direction: 'Inbound', access: 'Deny', protocol: '*', sourceAddressPrefix: '*', sourcePortRange: '*', destinationAddressPrefix: '*', destinationPortRange: '*' } }
    ]
  }
}
resource nic 'Microsoft.Network/networkInterfaces@2023-09-01' = {
  name: '${hostName}-nic'
  location: location
  properties: {
    networkSecurityGroup: { id: hostNsg.id }
    ipConfigurations: [
      { name: 'research', properties: { primary: true, privateIPAllocationMethod: 'Dynamic', subnet: { id: subnetId } } }
      { name: 'collector', properties: { primary: false, privateIPAllocationMethod: 'Dynamic', subnet: { id: subnetId } } }
    ]
  }
}
resource dataDisk 'Microsoft.Compute/disks@2023-04-02' = {
  name: '${hostName}-research-data'
  location: location
  sku: { name: 'StandardSSD_LRS' }
  properties: { creationData: { createOption: 'Empty' }, diskSizeGB: 32 }
}
resource host 'Microsoft.Compute/virtualMachines@2023-09-01' = {
  name: hostName
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    hardwareProfile: { vmSize: vmSize }
    storageProfile: {
      imageReference: { publisher: 'Canonical', offer: '0001-com-ubuntu-server-jammy', sku: '22_04-lts-gen2', version: imageVersion }
      osDisk: { createOption: 'FromImage', managedDisk: { storageAccountType: 'StandardSSD_LRS' } }
      dataDisks: [{ lun: 0, createOption: 'Attach', managedDisk: { id: dataDisk.id } }]
    }
    osProfile: { computerName: hostName, adminUsername: adminUsername, linuxConfiguration: { disablePasswordAuthentication: true, ssh: { publicKeys: [{ path: '/home/${adminUsername}/.ssh/authorized_keys', keyData: sshPublicKey }] } } }
    networkProfile: { networkInterfaces: [{ id: nic.id }] }
  }
}
output hostId string = host.id
output nicId string = nic.id
output dataDiskId string = dataDisk.id
output hostPrincipalId string = host.identity.principalId
output researchPrivateIp string = nic.properties.ipConfigurations[0].properties.privateIPAddress
output collectorPrivateIp string = nic.properties.ipConfigurations[1].properties.privateIPAddress
