// Trusted bootstrap template for the candidate ACI U6/U8 non-counted pilot.
// It pre-creates exact run identities and grants the controller access only at
// each identity/container resource scope. This file has not been deployed.
targetScope = 'resourceGroup'

@description('Controller managed-identity principal object ID.')
param controllerPrincipalId string
@description('Frozen-schedule-derived identitySpecs from create-aci-identity-manifest.mjs.')
@minLength(1)
param identitySpecs array
@description('Fixture Storage account containing only synthetic session markers.')
param fixtureStorageAccountName string
@description('Exact U6 marker container.')
param u6MarkerContainerName string = 'session-b'
@description('Exact U8 marker container.')
param u8MarkerContainerName string = 'prior-session'

var blobContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var roleAdminRoleId = 'f58310d9-a9f6-439a-9e8d-f62e7b41a168'
var u6Specs = filter(identitySpecs, spec => (spec.role == 'source' || spec.role == 'cleanup') && spec.container == 'session-b')
var u8Specs = filter(identitySpecs, spec => (spec.role == 'source' || spec.role == 'cleanup') && spec.container == 'prior-session')
var u6AllowedPrincipals = map(filter(identitySpecs, spec => (spec.role == 'source' || spec.role == 'cleanup') && spec.container == 'session-b'), spec => spec.principalId)
var u8AllowedPrincipals = map(filter(identitySpecs, spec => (spec.role == 'source' || spec.role == 'cleanup') && spec.container == 'prior-session'), spec => spec.principalId)
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: fixtureStorageAccountName
}
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: storage
  name: 'default'
}
resource u6Container 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = {
  parent: blobService
  name: u6MarkerContainerName
}
resource u8Container 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = {
  parent: blobService
  name: u8MarkerContainerName
}

resource identityLifecycleRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, 'aci-run-identity-delete-attach')
  properties: {
    roleName: 'ACI Run Identity Attach and Delete'
    description: 'Read, attach, and delete only the explicitly pre-provisioned run-scoped UAIs at per-identity assignment scopes.'
    type: 'CustomRole'
    permissions: [{
      actions: [
        'Microsoft.ManagedIdentity/userAssignedIdentities/read'
        'Microsoft.ManagedIdentity/userAssignedIdentities/delete'
        'Microsoft.ManagedIdentity/userAssignedIdentities/assign/action'
      ]
      notActions: []
      dataActions: []
      notDataActions: []
    }]
    assignableScopes: [resourceGroup().id]
  }
}

resource identityResources 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = [for spec in identitySpecs: {
  name: spec.name
  location: resourceGroup().location
  tags: {
    experimentRunId: spec.runId
    experimentScenario: spec.scenario
    experimentRole: spec.role
    experimentContainer: spec.container
    managedBy: 'thesis-aci-pilot-bootstrap'
  }
}]

// This module creates controller role assignments at each known UAI resource
// scope. The controller receives no UAI create/update permission.
module perIdentityAccess './aci-run-identity-access.bicep' = [for (spec, i) in identitySpecs: {
  name: 'identity-access-${uniqueString(spec.name)}'
  scope: resourceGroup()
  params: {
    identityName: spec.name
    controllerPrincipalId: controllerPrincipalId
    identityLifecycleRoleDefinitionId: identityLifecycleRole.id
  }
  dependsOn: [identityResources[i]]
}]

// Pre-create Blob Data Contributor only for source/cleanup identities, at the
// exact marker container. Probe identities intentionally receive no Blob role.
resource u6MarkerRoleAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (spec, i) in identitySpecs: if ((spec.role == 'source' || spec.role == 'cleanup') && spec.container == 'session-b') {
  name: guid(u6Container.id, spec.name, blobContributorRoleId)
  scope: u6Container
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobContributorRoleId)
    principalId: spec.principalId
    principalType: 'ServicePrincipal'
  }
}]
resource u8MarkerRoleAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (spec, i) in identitySpecs: if ((spec.role == 'source' || spec.role == 'cleanup') && spec.container == 'prior-session') {
  name: guid(u8Container.id, spec.name, blobContributorRoleId)
  scope: u8Container
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobContributorRoleId)
    principalId: spec.principalId
    principalType: 'ServicePrincipal'
  }
}]

// Controller receives only conditioned role-assignment administration at the
// exact marker containers. PrincipalId and role ID are both constrained.
resource u6ControllerRoleAssignmentOperator 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (length(u6Specs) > 0) {
  name: guid(u6Container.id, controllerPrincipalId, roleAdminRoleId)
  scope: u6Container
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleAdminRoleId)
    principalId: controllerPrincipalId
    principalType: 'ServicePrincipal'
    condition: $'''
    ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR
      (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${blobContributorRoleId}} AND
       @Request[Microsoft.Authorization/roleAssignments:PrincipalId] ForAnyOfAnyValues:GuidEquals {${join(u6AllowedPrincipals, ',')}}))
    AND
    ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR
      (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${blobContributorRoleId}} AND
       @Resource[Microsoft.Authorization/roleAssignments:PrincipalId] ForAnyOfAnyValues:GuidEquals {${join(u6AllowedPrincipals, ',')}}))
    '''
    conditionVersion: '2.0'
  }
}
resource u8ControllerRoleAssignmentOperator 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (length(u8Specs) > 0) {
  name: guid(u8Container.id, controllerPrincipalId, roleAdminRoleId)
  scope: u8Container
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleAdminRoleId)
    principalId: controllerPrincipalId
    principalType: 'ServicePrincipal'
    condition: $'''
    ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR
      (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${blobContributorRoleId}} AND
       @Request[Microsoft.Authorization/roleAssignments:PrincipalId] ForAnyOfAnyValues:GuidEquals {${join(u8AllowedPrincipals, ',')}}))
    AND
    ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR
      (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${blobContributorRoleId}} AND
       @Resource[Microsoft.Authorization/roleAssignments:PrincipalId] ForAnyOfAnyValues:GuidEquals {${join(u8AllowedPrincipals, ',')}}))
    '''
    conditionVersion: '2.0'
  }
}

output identityCount int = length(identitySpecs)
output identityLifecycleRoleDefinitionId string = identityLifecycleRole.id
output controllerMayCreateOrUpdateIdentities bool = false
output controllerAssignmentScopes array = [for spec in identitySpecs: resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', spec.name)]

