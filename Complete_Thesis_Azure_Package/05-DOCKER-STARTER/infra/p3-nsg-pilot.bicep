// Candidate outbound policy for a disposable VM pilot only. It is not attached
// to a subnet here. Azure platform dependencies and enforcer logging MUST be
// evaluated before use; this is not a validated Functions or sessions policy.
param location string = resourceGroup().location
param nsgName string
@description('Controlled research service private IPv4 address or CIDR.')
param researchDestination string
@description('Private IPv4 address of the independently controlled synthetic Blob endpoint.')
param fixtureStorageDestination string
@minValue(1)
@maxValue(65535)
param researchPort int

resource nsg 'Microsoft.Network/networkSecurityGroups@2023-09-01' = {
  name: nsgName
  location: location
  properties: {
    securityRules: [
      {
        name: 'allow-research-service'
        properties: {
          priority: 100
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: researchDestination
          destinationPortRange: string(researchPort)
        }
      }
      {
        name: 'allow-synthetic-blob-https'
        properties: {
          priority: 105
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: fixtureStorageDestination
          destinationPortRange: '443'
        }
      }
      {
        name: 'allow-azure-dns-udp'
        properties: {
          priority: 110
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Udp'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: 'AzurePlatformDNS'
          destinationPortRange: '53'
        }
      }
      {
        name: 'allow-azure-dns-tcp'
        properties: {
          priority: 111
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: 'AzurePlatformDNS'
          destinationPortRange: '53'
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
output nsgId string = nsg.id
