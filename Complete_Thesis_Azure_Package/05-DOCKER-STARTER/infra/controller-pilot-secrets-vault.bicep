targetScope = 'resourceGroup'

@description('Firewall-restricted pilot secret store. Use the exact existing vault name.')
param vaultName string = 'thesisexpkv20261103'
@description('Controller identity that reads only the pilot secrets at runtime.')
param controllerIdentityName string = 'id-thesis-fixture-controller'

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: vaultName
}

resource controllerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: controllerIdentityName
}

var secretsUserRole = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)

resource controllerReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, controllerIdentity.id, secretsUserRole)
  scope: vault
  properties: {
    roleDefinitionId: secretsUserRole
    principalId: controllerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

output controllerReaderAssignmentId string = controllerReader.id
