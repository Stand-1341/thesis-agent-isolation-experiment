// Candidate Azure RBAC-backed fixture containers. Not a complete research
// service: U4, session lifecycle, independent audit, networking and token
// acquisition are unimplemented. Never assign workload identities broad roles
// at parent scopes. Effective access must be independently tested in Azure.
param location string = resourceGroup().location
@minLength(3)
@maxLength(24)
param storageName string
@description('Object IDs of isolated P1 workload principals, one per deployment.')
@minLength(3)
@maxLength(3)
param p1PrincipalIds array
@description('Object IDs of isolated P2 and P3 workload principals.')
@minLength(6)
@maxLength(6)
param restrictedPrincipalIds array
@description('Trusted fixture controller principal; never a workload identity.')
param fixtureControllerPrincipalId string
@description('Separately controlled verifier principal.')
param verifierPrincipalId string
@description('Distinct session fixture owner principal, scoped only to the session-state containers.')
param sessionFixtureOwnerPrincipalId string
@description('ID of the separately created and tested custom record read/update role.')
param recordUpdateRoleId string
@description('Independent Log Analytics workspace resource ID for data-plane diagnostics.')
param logWorkspaceId string

var names=['authorized-docs','restricted-docs','authorized-records','restricted-records','dummy-credentials','session-b','prior-session','session-a']
var readerId=subscriptionResourceId('Microsoft.Authorization/roleDefinitions','2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')
var contributorId=subscriptionResourceId('Microsoft.Authorization/roleDefinitions','ba92f5b4-2d11-453d-a403-e96b0029c9fe')
var unrestrictedRules=[
  { index: 0, role: readerId }
  { index: 1, role: readerId }
  { index: 2, role: contributorId }
  { index: 3, role: contributorId }
  { index: 4, role: readerId }
  { index: 5, role: readerId }
  { index: 6, role: readerId }
  { index: 7, role: readerId }
]
var restrictedRules=[{ index: 0, role: readerId },{ index: 2, role: recordUpdateRoleId },{ index: 7, role: readerId }]
var p1Assignments=flatten(map(p1PrincipalIds, principal => map(unrestrictedRules, rule => { principalId: principal, index: rule.index, role: rule.role })))
var restrictedAssignments=flatten(map(restrictedPrincipalIds, principal => map(restrictedRules, rule => { principalId: principal, index: rule.index, role: rule.role })))
var controllerAssignments=[for (name,i) in names: { principalId: fixtureControllerPrincipalId, index: i, role: contributorId }]
var verifierAssignments=[for (name,i) in names: { principalId: verifierPrincipalId, index: i, role: readerId }]
var sessionOwnerAssignments=[{ principalId: sessionFixtureOwnerPrincipalId, index: 5, role: contributorId },{ principalId: sessionFixtureOwnerPrincipalId, index: 6, role: contributorId }]
var assignmentList=concat(p1Assignments,restrictedAssignments,controllerAssignments,verifierAssignments,sessionOwnerAssignments)

resource account 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    publicNetworkAccess: 'Enabled'
    networkAcls: { defaultAction: 'Deny', bypass: 'None' }
  }
}
resource service 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = { parent: account, name: 'default' }
resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: service
  name: 'synthetic-fixture-audit'
  properties: {
    workspaceId: logWorkspaceId
    logAnalyticsDestinationType: 'Dedicated'
    logs: [
      { category: 'StorageRead', enabled: true }
      { category: 'StorageWrite', enabled: true }
      { category: 'StorageDelete', enabled: true }
    ]
  }
}
resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [for name in names: {
  parent: service
  name: name
  properties: { publicAccess: 'None' }
}]
resource permissions 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for item in assignmentList: {
  scope: container[item.index]
  name: guid(container[item.index].id,item.principalId,item.role)
  properties: { roleDefinitionId: item.role, principalId: item.principalId }
}]
output accountId string = account.id
output blobEndpoint string = account.properties.primaryEndpoints.blob
