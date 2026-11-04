// Additive, isolated infrastructure subnet for a new workload-profiles ACA
// environment used by the custom-container session routes. The existing
// `cae-thesis-diagnostic` environment is Consumption-only and cannot be
// converted in place. This subnet has no route table or NSG: the active session
// profiles in revision 2 are P1/P2, and session P3 was withdrawn.
param virtualNetworkName string
@description('Dedicated, non-overlapping subnet for the new workload-profiles environment. Workload-profile environments require /27 or larger and Microsoft.App/environments delegation.')
param subnetPrefix string

resource vnet 'Microsoft.Network/virtualNetworks@2023-09-01' existing = {
  name: virtualNetworkName
}

resource sessionEnvironmentSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' = {
  parent: vnet
  name: 'sessions-experiment'
  properties: {
    addressPrefix: subnetPrefix
    delegations: [{
      name: 'container-apps-environment'
      properties: { serviceName: 'Microsoft.App/environments' }
    }]
  }
}

output subnetId string = sessionEnvironmentSubnet.id
output subnetPrefix string = subnetPrefix
