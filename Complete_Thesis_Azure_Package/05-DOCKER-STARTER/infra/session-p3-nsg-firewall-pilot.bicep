// Diagnostic-only variant: let session egress reach the forced UDR so the
// Azure Firewall can provide independently attributable allow/deny records.
// This is not an accepted P3 policy until firewall logs prove every prohibited
// path is denied and required application traffic still succeeds.
param location string = resourceGroup().location
param nsgName string
param sessionSubnetPrefix string

resource nsg 'Microsoft.Network/networkSecurityGroups@2023-09-01' = {
  name: nsgName
  location: location
  properties: {
    securityRules: [
      {
        name: 'allow-session-egress-to-forced-route'
        properties: {
          priority: 4000
          direction: 'Outbound'
          access: 'Allow'
          protocol: '*'
          sourceAddressPrefix: sessionSubnetPrefix
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

output nsgId string = nsg.id
