// Nested resource-group-scope module for the resource-scoped assignments used
// by aci-controller-roles-pilot.bicep. Deploying here permits narrow role
// assignments on one subnet and the three named UAI resources.
targetScope = 'resourceGroup'

param vnetName string
param subnetName string
param controllerPrincipalId string
param pullIdentityName string
param p1WorkloadIdentityName string
param p2WorkloadIdentityName string
param aciLifecycleRoleDefinitionId string
param aciSubnetJoinRoleDefinitionId string
param uaiAttachRoleDefinitionId string

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' existing = {
  name: vnetName
}
resource aciSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  parent: vnet
  name: subnetName
}
resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: pullIdentityName
}
resource p1WorkloadIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: p1WorkloadIdentityName
}
resource p2WorkloadIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: p2WorkloadIdentityName
}

resource aciLifecycleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, controllerPrincipalId, aciLifecycleRoleDefinitionId)
  properties: {
    roleDefinitionId: aciLifecycleRoleDefinitionId
    principalId: controllerPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource aciSubnetJoinAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: aciSubnet
  name: guid(aciSubnet.id, controllerPrincipalId, aciSubnetJoinRoleDefinitionId)
  properties: {
    roleDefinitionId: aciSubnetJoinRoleDefinitionId
    principalId: controllerPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource pullIdentityAttachAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: pullIdentity
  name: guid(pullIdentity.id, controllerPrincipalId, uaiAttachRoleDefinitionId)
  properties: {
    roleDefinitionId: uaiAttachRoleDefinitionId
    principalId: controllerPrincipalId
    principalType: 'ServicePrincipal'
  }
}
resource p1IdentityAttachAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: p1WorkloadIdentity
  name: guid(p1WorkloadIdentity.id, controllerPrincipalId, uaiAttachRoleDefinitionId)
  properties: {
    roleDefinitionId: uaiAttachRoleDefinitionId
    principalId: controllerPrincipalId
    principalType: 'ServicePrincipal'
  }
}
resource p2IdentityAttachAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: p2WorkloadIdentity
  name: guid(p2WorkloadIdentity.id, controllerPrincipalId, uaiAttachRoleDefinitionId)
  properties: {
    roleDefinitionId: uaiAttachRoleDefinitionId
    principalId: controllerPrincipalId
    principalType: 'ServicePrincipal'
  }
}
