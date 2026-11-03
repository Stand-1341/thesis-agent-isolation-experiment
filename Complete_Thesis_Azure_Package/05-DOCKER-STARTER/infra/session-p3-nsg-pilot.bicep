// Candidate for a disposable session pilot. Azure platform service-tag and
// same-subnet exceptions remain reachable by workloads; validate and document
// them independently before using this policy for any measured trial.
param location string = resourceGroup().location
param nsgName string
param sessionSubnetPrefix string
param researchIp string
param collectorIp string
param blobIp string
@description('Observed session management endpoint IPv4, which can change; re-resolve before every pilot.')
param managementIp string
param registryIps array

var platformTags = ['MicrosoftContainerRegistry', 'AzureFrontDoor.FirstParty', 'AzureActiveDirectory', 'AzureMonitor', 'AzureContainerRegistry', 'Storage.EastUS', 'AzureResourceManager']
var platformRules = [for (tag, index) in platformTags: {
  name: 'allow-platform-${index}'
  properties: {priority: 200 + index, direction: 'Outbound', access: 'Allow', protocol: 'Tcp', sourceAddressPrefix: '*', sourcePortRange: '*', destinationAddressPrefix: tag, destinationPortRange: '443'}
}]

resource nsg 'Microsoft.Network/networkSecurityGroups@2023-09-01' = {
  name: nsgName
  location: location
  properties: {
    securityRules: concat([
      {name: 'deny-collector', properties: {priority: 100, direction: 'Outbound', access: 'Deny', protocol: '*', sourceAddressPrefix: '*', sourcePortRange: '*', destinationAddressPrefix: collectorIp, destinationPortRange: '*'}}
      {name: 'allow-research', properties: {priority: 110, direction: 'Outbound', access: 'Allow', protocol: 'Tcp', sourceAddressPrefix: '*', sourcePortRange: '*', destinationAddressPrefix: researchIp, destinationPortRange: '443'}}
      {name: 'allow-blob', properties: {priority: 120, direction: 'Outbound', access: 'Allow', protocol: 'Tcp', sourceAddressPrefix: '*', sourcePortRange: '*', destinationAddressPrefix: blobIp, destinationPortRange: '443'}}
      {name: 'allow-registry-private', properties: {priority: 130, direction: 'Outbound', access: 'Allow', protocol: 'Tcp', sourceAddressPrefix: '*', sourcePortRange: '*', destinationAddressPrefixes: registryIps, destinationPortRange: '443'}}
      {name: 'allow-session-management-ip', properties: {priority: 135, direction: 'Outbound', access: 'Allow', protocol: 'Tcp', sourceAddressPrefix: '*', sourcePortRange: '*', destinationAddressPrefix: managementIp, destinationPortRange: '443'}}
      {name: 'allow-platform-intra-subnet', properties: {priority: 140, direction: 'Outbound', access: 'Allow', protocol: '*', sourceAddressPrefix: sessionSubnetPrefix, sourcePortRange: '*', destinationAddressPrefix: sessionSubnetPrefix, destinationPortRange: '*'}}
    ], platformRules, [
      {name: 'deny-other-outbound', properties: {priority: 4000, direction: 'Outbound', access: 'Deny', protocol: '*', sourceAddressPrefix: '*', sourcePortRange: '*', destinationAddressPrefix: '*', destinationPortRange: '*'}}
    ])
  }
}
output nsgId string = nsg.id
