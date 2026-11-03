// Network skeleton only. It does not implement selective egress, private
// controller connectivity, fixture endpoints, DNS, or logging. Do not use for trials.
param location string = resourceGroup().location
@minLength(1)
@maxLength(50)
param networkName string
param tags object = { Study: 'AzureThesisExperiment', Phase: 'Pilot' }

resource network 'Microsoft.Network/virtualNetworks@2023-09-01' = {
  name: networkName
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: ['10.48.0.0/16'] }
    subnets: [
      { name: 'vm-pilot', properties: { addressPrefix: '10.48.0.0/24' } }
      {
        name: 'functions-pilot'
        properties: {
          addressPrefix: '10.48.1.0/24'
          delegations: [{ name: 'functions-delegation', properties: { serviceName: 'Microsoft.App/environments' } }]
          serviceEndpoints: [{ service: 'Microsoft.Storage' }]
        }
      }
      {
        name: 'sessions-pilot'
        properties: {
          addressPrefix: '10.48.2.0/23'
          delegations: [{ name: 'sessions-delegation', properties: { serviceName: 'Microsoft.App/environments' } }]
        }
      }
      { name: 'evidence-private-endpoints', properties: { addressPrefix: '10.48.4.0/27' } }
      { name: 'functions-p2', properties: { addressPrefix: '10.48.5.0/24', delegations: [{ name: 'functions-delegation', properties: { serviceName: 'Microsoft.App/environments' } }], serviceEndpoints: [{ service: 'Microsoft.Storage' }] } }
      { name: 'functions-p3', properties: { addressPrefix: '10.48.6.0/24', delegations: [{ name: 'functions-delegation', properties: { serviceName: 'Microsoft.App/environments' } }], serviceEndpoints: [{ service: 'Microsoft.Storage' }] } }
      { name: 'vm-p2', properties: { addressPrefix: '10.48.7.0/24' } }
      { name: 'vm-p3', properties: { addressPrefix: '10.48.8.0/24' } }
      { name: 'research-services', properties: { addressPrefix: '10.48.9.0/24' } }
      // Required subnet name/size for the candidate ACA session egress firewall.
      { name: 'AzureFirewallSubnet', properties: { addressPrefix: '10.48.10.0/26' } }
      // Basic Azure Firewall also requires a separate management subnet.
      { name: 'AzureFirewallManagementSubnet', properties: { addressPrefix: '10.48.10.64/26' } }
    ]
  }
}

output vmSubnetId string = '${network.id}/subnets/vm-pilot'
output vmP2SubnetId string = '${network.id}/subnets/vm-p2'
output vmP3SubnetId string = '${network.id}/subnets/vm-p3'
output functionsSubnetId string = '${network.id}/subnets/functions-pilot'
output functionsP2SubnetId string = '${network.id}/subnets/functions-p2'
output functionsP3SubnetId string = '${network.id}/subnets/functions-p3'
output sessionsSubnetId string = '${network.id}/subnets/sessions-pilot'
output evidenceSubnetId string = '${network.id}/subnets/evidence-private-endpoints'
output vnetId string = network.id
output researchServicesSubnetId string = '${network.id}/subnets/research-services'
