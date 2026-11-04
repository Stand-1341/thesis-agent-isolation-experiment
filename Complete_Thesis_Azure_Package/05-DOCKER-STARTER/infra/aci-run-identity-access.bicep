// Instantiated once per pre-created UAI by aci-preprovisioned-run-identities.bicep.
targetScope = 'resourceGroup'
param identityName string
param controllerPrincipalId string
param identityLifecycleRoleDefinitionId string
var roleAdminRoleId = 'f58310d9-a9f6-439a-9e8d-f62e7b41a168'
var identityLifecycleRoleGuid = last(split(identityLifecycleRoleDefinitionId, '/'))

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: identityName
}
resource controllerIdentityAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(identity.id, controllerPrincipalId, identityLifecycleRoleDefinitionId)
  scope: identity
  properties: {
    roleDefinitionId: identityLifecycleRoleDefinitionId
    principalId: controllerPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Limits the controller's role-assignment management at this exact UAI scope
// to removing its own attach/delete and this delegated cleanup grant.
resource controllerIdentityScopeCleanup 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(identity.id, controllerPrincipalId, roleAdminRoleId, 'cleanup-own-grants')
  scope: identity
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleAdminRoleId)
    principalId: controllerPrincipalId
    principalType: 'ServicePrincipal'
    condition: $'''
    ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR
      (@Request[Microsoft.Authorization/roleAssignments:PrincipalId] ForAnyOfAnyValues:GuidEquals {${controllerPrincipalId}} AND
       @Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${identityLifecycleRoleGuid}, ${roleAdminRoleId}}))
    AND
    ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR
      (@Resource[Microsoft.Authorization/roleAssignments:PrincipalId] ForAnyOfAnyValues:GuidEquals {${controllerPrincipalId}} AND
       @Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${identityLifecycleRoleGuid}, ${roleAdminRoleId}}))
    '''
    conditionVersion: '2.0'
  }
}

