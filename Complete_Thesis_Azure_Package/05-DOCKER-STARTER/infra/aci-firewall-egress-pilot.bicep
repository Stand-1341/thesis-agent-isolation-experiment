// P1/P2 ACI baseline egress through the already deployed firewall. This is
// intentionally broad because ACI P1/P2 are not the network-restricted P3 arm.
// Do not associate this source range with an ACI P3 claim.
param firewallPolicyName string = 'thesis-p3-fw-policy'
param ruleCollectionGroupName string = 'aci-p1p2-pilot-egress'
@minValue(100)
@maxValue(65000)
param groupPriority int = 400
@description('Must match the dedicated ACI P1/P2 subnet and its NSG.')
param sourcePrefix string = '10.48.13.0/24'

resource policy 'Microsoft.Network/firewallPolicies@2023-09-01' existing = {
  name: firewallPolicyName
}

resource aciEgress 'Microsoft.Network/firewallPolicies/ruleCollectionGroups@2023-09-01' = {
  parent: policy
  name: ruleCollectionGroupName
  properties: {
    priority: groupPriority
    ruleCollections: [{
      name: 'aci-p1p2-open-egress'
      priority: 100
      ruleCollectionType: 'FirewallPolicyFilterRuleCollection'
      action: { type: 'Allow' }
      rules: [{
        name: 'aci-p1p2-permissive-network-baseline'
        ruleType: 'NetworkRule'
        ipProtocols: ['Any']
        sourceAddresses: [sourcePrefix]
        destinationAddresses: ['*']
        destinationPorts: ['*']
      }]
    }]
  }
}

output ruleCollectionGroupId string = aciEgress.id
