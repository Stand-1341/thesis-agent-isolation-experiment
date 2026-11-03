// Candidate subscription-scoped custom role; never deployed by this file alone.
// Real GET/PUT success, DELETE denial, permission propagation and inherited
// grants must all be verified before treating it as least privilege.
targetScope = 'subscription'
param roleName string = 'Thesis synthetic record reader and updater'
resource role 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id,'thesis-synthetic-record-read-write-v1')
  properties: {
    roleName: roleName
    description: 'Read and update synthetic research blobs; no delete data action.'
    type: 'CustomRole'
    assignableScopes: [subscription().id]
    permissions: [{
      actions: []
      notActions: []
      dataActions: [
        'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read'
        'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write'
      ]
      notDataActions: []
    }]
  }
}
output roleDefinitionId string = role.id
