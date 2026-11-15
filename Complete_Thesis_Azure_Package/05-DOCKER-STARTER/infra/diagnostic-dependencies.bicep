// Candidate dependencies for the disposable session diagnostic. No network
// policy or experiment fixtures are configured here.
param location string = resourceGroup().location
@minLength(5)
@maxLength(50)
param registryName string
@minLength(4)
@maxLength(63)
param workspaceName string
param pullIdentityName string
@description('Single trusted controller public IP in CIDR notation. Workloads must never be included.')
param trustedControllerPublicIp string
param tags object = { Study: 'AzureThesisExperiment', Phase: 'Pilot' }

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  tags: tags
  sku: { name: 'Premium' }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
    networkRuleSet: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
      ipRules: [{ action: 'Allow', value: trustedControllerPublicIp }]
    }
  }
}
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  tags: tags
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30 }
}
resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: pullIdentityName
  location: location
  tags: tags
}
resource pullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, pullIdentity.id, 'acr-pull')
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
    principalId: pullIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
output registryServer string = registry.properties.loginServer
output pullIdentityId string = pullIdentity.id
output pullIdentityClientId string = pullIdentity.properties.clientId
output logWorkspaceId string = logs.id
output logCustomerId string = logs.properties.customerId
