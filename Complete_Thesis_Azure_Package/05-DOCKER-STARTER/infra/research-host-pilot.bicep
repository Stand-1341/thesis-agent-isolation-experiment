// Candidate private research/collector host. No software, TLS, disk formatting,
// external audit protection, P3 enforcement, or controller connectivity is installed.
param location string = resourceGroup().location
@minLength(1)
@maxLength(40)
param hostName string
@description('Dedicated research-services subnet resource ID.')
param subnetId string
@description('Reserved private IPv4 for the research listener. Must be unused in the research-services subnet.')
param researchServicePrivateIp string
@description('Reserved private IPv4 for the collector listener. Must be unused in the research-services subnet.')
param collectorPrivateIp string
@description('Name of the existing Key Vault using Azure RBAC authorization and containing all 14 bootstrap secrets before host deployment.')
param vaultName string
@description('Prefix used by the three-arm workload-token secret names.')
param namePrefix string
@description('Exact source subnet CIDRs permitted to reach the research service on TCP/443. Include every active VM, Functions, and session route source subnet, including P1/P2/P3. Supply explicit values after network review; do not use broad VNet CIDRs.')
@minLength(1)
@maxLength(100)
param researchSourcePrefixes array
@description('Exact P1/P2-only source subnet CIDRs permitted to reach the collector on TCP/8443. Include VM P1/P2, Functions P1/P2, and session P1/P2 subnets. Exclude every P3 subnet. Supply explicit values after network review; do not use broad VNet CIDRs.')
@minLength(1)
@maxLength(100)
param collectorSourcePrefixes array
@description('All active workload subnet CIDRs allowed to contact the restricted receiver on TCP/9443. P3 egress policy must separately deny this target for P3 workloads.')
@minLength(1)
@maxLength(100)
param restrictedSourcePrefixes array
@description('Exact operator/controller CIDRs with a working private route; not workload CIDRs.')
@minLength(1)
param operatorSourcePrefixes array
param sshPublicKey string
param imageVersion string
param adminUsername string = 'thesisadmin'
param vmSize string = 'Standard_F1as_v7'
@description('Reserved private IPv4 for the distinct restricted receiver listener. Must be unused in the research-services subnet and distinct from both research and collector listener addresses.')
param restrictedServicePrivateIp string
param restrictedServicePort int = 9443

resource hostNsg 'Microsoft.Network/networkSecurityGroups@2023-09-01' = {
  name: '${hostName}-nsg'
  location: location
  properties: {
    securityRules: [
      { name: 'research-https', properties: { priority: 100, direction: 'Inbound', access: 'Allow', protocol: 'Tcp', sourceAddressPrefixes: researchSourcePrefixes, sourcePortRange: '*', destinationAddressPrefix: '*', destinationPortRange: '443' } }
      { name: 'collector-https', properties: { priority: 110, direction: 'Inbound', access: 'Allow', protocol: 'Tcp', sourceAddressPrefixes: collectorSourcePrefixes, sourcePortRange: '*', destinationAddressPrefix: '*', destinationPortRange: '8443' } }
      { name: 'restricted-receiver-https', properties: { priority: 115, direction: 'Inbound', access: 'Allow', protocol: 'Tcp', sourceAddressPrefixes: restrictedSourcePrefixes, sourcePortRange: '*', destinationAddressPrefix: '*', destinationPortRange: string(restrictedServicePort) } }
      { name: 'operator-services', properties: { priority: 120, direction: 'Inbound', access: 'Allow', protocol: 'Tcp', sourceAddressPrefixes: operatorSourcePrefixes, sourcePortRange: '*', destinationAddressPrefix: '*', destinationPortRanges: ['22', '443', '8443', string(restrictedServicePort)] } }
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
      { name: 'research', properties: { primary: true, privateIPAllocationMethod: 'Static', privateIPAddress: researchServicePrivateIp, subnet: { id: subnetId } } }
      { name: 'collector', properties: { primary: false, privateIPAllocationMethod: 'Static', privateIPAddress: collectorPrivateIp, subnet: { id: subnetId } } }
      { name: 'restricted', properties: { primary: false, privateIPAllocationMethod: 'Static', privateIPAddress: restrictedServicePrivateIp, subnet: { id: subnetId } } }
    ]
  }
}
resource dataDisk 'Microsoft.Compute/disks@2023-04-02' = {
  name: '${hostName}-research-data'
  location: location
  sku: { name: 'StandardSSD_LRS' }
  properties: { creationData: { createOption: 'Empty' }, diskSizeGB: 32 }
}
resource hostSecretReader 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${hostName}-secret-reader'
  location: location
  tags: { identityPurpose: 'research-host-secret-reader' }
}
resource host 'Microsoft.Compute/virtualMachines@2023-09-01' = {
  name: hostName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${hostSecretReader.id}': {} }
  }
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
var hostSecretNames = [
  '${namePrefix}-vm-p1-workload-token'
  '${namePrefix}-job-p1-workload-token'
  '${namePrefix}-sbx-p1-workload-token'
  '${namePrefix}-vm-p2-workload-token'
  '${namePrefix}-job-p2-workload-token'
  '${namePrefix}-sbx-p2-workload-token'
  '${namePrefix}-vm-p3-workload-token'
  '${namePrefix}-job-p3-workload-token'
  '${namePrefix}-sbx-p3-workload-token'
  'resource-admin-key'
  'collector-admin-key'
  'functions-p1-resource-verifier-key'
  'functions-p1-collector-verifier-key'
  '${namePrefix}-host-tls-ca-private-key'
]
module hostSecretReaderAssignments './route-secret-reader-rbac.bicep' = [for (secretName, index) in hostSecretNames: {
  name: '${hostName}-secret-reader-${index}'
  params: {
    vaultName: vaultName
    secretName: secretName
    readerIdentityName: hostSecretReader.name
  }
}]
output hostId string = host.id
output nicId string = nic.id
output dataDiskId string = dataDisk.id
output hostSecretReaderPrincipalId string = hostSecretReader.properties.principalId
output hostSecretReaderClientId string = hostSecretReader.properties.clientId
output hostSecretReaderIdentityResourceId string = hostSecretReader.id
output researchPrivateIp string = nic.properties.ipConfigurations[0].properties.privateIPAddress
output collectorPrivateIp string = nic.properties.ipConfigurations[1].properties.privateIPAddress
output restrictedPrivateIp string = nic.properties.ipConfigurations[2].properties.privateIPAddress
