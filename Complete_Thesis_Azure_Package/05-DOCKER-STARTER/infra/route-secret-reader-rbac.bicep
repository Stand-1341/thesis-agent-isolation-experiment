targetScope = 'resourceGroup'

@description('Name of an existing Key Vault. This module never creates or reads a secret value.')
param vaultName string

@description('Exact name of a pre-created workload-token secret to scope this reader to.')
param secretName string

@description('Name of this route\'s dedicated user-assigned secret-reader identity.')
param readerIdentityName string

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: vaultName
}

resource tokenSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = {
  parent: vault
  name: secretName
}

resource readerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: readerIdentityName
}

var secretsUserRole = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)

resource tokenSecretReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(tokenSecret.id, readerIdentity.id, secretsUserRole)
  scope: tokenSecret
  properties: {
    roleDefinitionId: secretsUserRole
    principalId: readerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

output assignmentId string = tokenSecretReader.id
