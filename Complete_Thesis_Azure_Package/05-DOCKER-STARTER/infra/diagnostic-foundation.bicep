// Phase-one diagnostic foundation only. This creates billable resources if
// deployed. It does not create the diagnostic pool or experiment workload.
param location string = resourceGroup().location
param networkName string
param registryName string
param workspaceName string
param pullIdentityName string
param tags object = { Study: 'AzureThesisExperiment', Phase: 'Pilot' }
@description('Single trusted controller public IP in CIDR notation; used to restrict public ACR pushes.')
param trustedControllerPublicIp string
param environmentName string

module network './network-pilot.bicep' = {
  name: 'diagnostic-network'
  params: { location: location, networkName: networkName, tags: tags }
}
module dependencies './diagnostic-dependencies.bicep' = {
  name: 'diagnostic-dependencies'
  params: {
    location: location
    registryName: registryName
    workspaceName: workspaceName
    pullIdentityName: pullIdentityName
    tags: tags
    trustedControllerPublicIp: trustedControllerPublicIp
  }
}
module environment './session-environment-pilot.bicep' = {
  name: 'diagnostic-environment'
  params: {
    location: location
    environmentName: environmentName
    infrastructureSubnetId: network.outputs.sessionsSubnetId
    tags: tags
    logCustomerId: dependencies.outputs.logCustomerId
    workspaceName: workspaceName
  }
}
output registryServer string = dependencies.outputs.registryServer
output pullIdentityId string = dependencies.outputs.pullIdentityId
output environmentId string = environment.outputs.environmentId
output virtualNetworkId string = network.outputs.vnetId
output vmSubnetId string = network.outputs.vmSubnetId
output vmP2SubnetId string = network.outputs.vmP2SubnetId
output vmP3SubnetId string = network.outputs.vmP3SubnetId
output functionsSubnetId string = network.outputs.functionsSubnetId
output functionsP2SubnetId string = network.outputs.functionsP2SubnetId
output functionsP3SubnetId string = network.outputs.functionsP3SubnetId
output evidenceSubnetId string = network.outputs.evidenceSubnetId
