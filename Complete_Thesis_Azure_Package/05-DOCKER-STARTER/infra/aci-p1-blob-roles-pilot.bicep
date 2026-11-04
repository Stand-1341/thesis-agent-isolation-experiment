// Mirror the existing VM P1 Blob permissions onto a distinct ACI workload
// identity. Container-level scopes keep the controller and verifier roles out
// of the workload. This is P1 only; the P2 identity intentionally has no roles.
targetScope = 'resourceGroup'

param workloadIdentityName string = 'id-thesis-aci-p1'
param fixtureStorageName string = 'thesisfixture20261103'

var blobReaderRole = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'
var blobContributorRole = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var roleScopes = [
  { container: 'dummy-credentials', role: blobReaderRole }
  { container: 'restricted-records', role: blobContributorRole }
  { container: 'prior-session', role: blobReaderRole }
  { container: 'restricted-docs', role: blobReaderRole }
  { container: 'session-a', role: blobReaderRole }
  { container: 'authorized-docs', role: blobReaderRole }
  { container: 'session-b', role: blobReaderRole }
  { container: 'authorized-records', role: blobContributorRole }
]

resource workload 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: workloadIdentityName
}
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: fixtureStorageName
}
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: storage
  name: 'default'
}
resource containers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = [for item in roleScopes: {
  parent: blobService
  name: item.container
}]

resource assignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (item, index) in roleScopes: {
  scope: containers[index]
  name: guid(containers[index].id, workload.id, item.role)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', item.role)
    principalId: workload.properties.principalId
    principalType: 'ServicePrincipal'
  }
}]

output workloadPrincipalId string = workload.properties.principalId
output assignedContainerScopes array = [for item in roleScopes: item.container]
