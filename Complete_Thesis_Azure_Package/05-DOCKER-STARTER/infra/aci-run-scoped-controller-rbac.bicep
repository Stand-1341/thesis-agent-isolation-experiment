// Least-privilege role grants for the candidate ACI U6/U8 identity provider.
// Deploying this template changes RBAC; it is not a readiness or method approval.
// The UAI lifecycle role intentionally omits assign/action: Azure role
// assignment conditions do not expose a verified UAI-name constraint for
// that action. See ACI-RUN-SCOPED-CONTROLLER-RBAC.md before deployment.
targetScope = 'resourceGroup'

@description('Controller managed-identity principal object ID.')
param controllerPrincipalId string
@description('Fixture Storage account containing the two synthetic session markers.')
param fixtureStorageAccountName string = 'thesisfixture20261103'
@description('Exact U6 marker container. Must be session-b for the current candidate method.')
param u6MarkerContainerName string = 'session-b'
@description('Exact U8 marker container. Must be prior-session for the current candidate method.')
param u8MarkerContainerName string = 'prior-session'
@description('Existing non-ephemeral identities in the pilot RG. CanNotDelete locks protect them from the UAI lifecycle grant.')
@minLength(1)
param protectedIdentityNames array

var roleBasedAccessControlAdministratorRoleId = 'f58310d9-a9f6-439a-9e8d-f62e7b41a168'
var roleAssignmentCondition = '''
((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR
  (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {ba92f5b4-2d11-453d-a403-e96b0029c9fe} AND
   @Request[Microsoft.Authorization/roleAssignments:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase {'ServicePrincipal'}))
AND
((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR
  (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {ba92f5b4-2d11-453d-a403-e96b0029c9fe} AND
   @Resource[Microsoft.Authorization/roleAssignments:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase {'ServicePrincipal'}))
'''

resource identityLifecycleRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, resourceGroup().id, 'thesis-aci-run-uai-lifecycle')
  properties: {
    roleName: 'Thesis ACI Run-Scoped UAI Lifecycle'
    description: 'Read, create/update, and delete UAIs in the ACI pilot resource group. Does not grant identity assignment or role-assignment permissions.'
    type: 'CustomRole'
    permissions: [{
      actions: [
        'Microsoft.ManagedIdentity/userAssignedIdentities/read'
        'Microsoft.ManagedIdentity/userAssignedIdentities/write'
        'Microsoft.ManagedIdentity/userAssignedIdentities/delete'
      ]
      notActions: []
      dataActions: []
      notDataActions: []
    }]
    assignableScopes: [resourceGroup().id]
  }
}

resource identityLifecycleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, controllerPrincipalId, identityLifecycleRole.id)
  properties: {
    roleDefinitionId: identityLifecycleRole.id
    principalId: controllerPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// These locks keep named infrastructure identities out of the controller's
// RG-scoped identity delete permission. Supply every existing non-ephemeral UAI.
resource protectedIdentities 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = [for identityName in protectedIdentityNames: {
  name: identityName
}]

resource protectedIdentityDeleteLocks 'Microsoft.Authorization/locks@2016-09-01' = [for (identityName, index) in protectedIdentityNames: {
  name: guid(protectedIdentities[index].id, 'protect-non-ephemeral-identity')
  scope: protectedIdentities[index]
  properties: {
    level: 'CanNotDelete'
    notes: 'Protect stable ACI pilot identities from the run-scoped identity lifecycle role.'
  }
}]

resource fixtureStorage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: fixtureStorageAccountName
}

resource fixtureBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: fixtureStorage
  name: 'default'
}

resource u6MarkerContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = {
  parent: fixtureBlobService
  name: u6MarkerContainerName
}

resource u8MarkerContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = {
  parent: fixtureBlobService
  name: u8MarkerContainerName
}

resource roleBasedAccessControlAdministrator 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  name: roleBasedAccessControlAdministratorRoleId
}

resource u6ContainerRoleAssignmentOperator 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(u6MarkerContainer.id, controllerPrincipalId, roleBasedAccessControlAdministratorRoleId)
  scope: u6MarkerContainer
  properties: {
    roleDefinitionId: roleBasedAccessControlAdministrator.id
    principalId: controllerPrincipalId
    principalType: 'ServicePrincipal'
    condition: roleAssignmentCondition
    conditionVersion: '2.0'
  }
}

resource u8ContainerRoleAssignmentOperator 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(u8MarkerContainer.id, controllerPrincipalId, roleBasedAccessControlAdministratorRoleId)
  scope: u8MarkerContainer
  properties: {
    roleDefinitionId: roleBasedAccessControlAdministrator.id
    principalId: controllerPrincipalId
    principalType: 'ServicePrincipal'
    condition: roleAssignmentCondition
    conditionVersion: '2.0'
  }
}

output identityLifecycleRoleDefinitionId string = identityLifecycleRole.id
output u6MarkerAssignmentScope string = u6MarkerContainer.id
output u8MarkerAssignmentScope string = u8MarkerContainer.id
output roleAssignmentRoleConditionIsBlobDataContributor bool = true
output roleAssignmentPrincipalTypeCondition string = 'ServicePrincipal'
output controllerMayAttachDynamicRunIdentities bool = false
