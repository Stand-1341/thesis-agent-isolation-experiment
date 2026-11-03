targetScope = 'resourceGroup'

@description('Existing registry to which the pull identity needs metadata read access.')
param registryName string = 'thesisacr74a95224'
@description('Existing user-assigned identity already holding AcrPull at the registry scope.')
param pullIdentityName string = 'id-thesis-acr-pull'

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: pullIdentityName
}

var readerRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'acdd72a7-3385-48ef-bd42-f606fba81ae7'
)

resource registryMetadataReaderRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, pullIdentity.id, readerRoleDefinitionId)
  scope: registry
  properties: {
    roleDefinitionId: readerRoleDefinitionId
    principalId: pullIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

output assignmentId string = registryMetadataReaderRole.id
