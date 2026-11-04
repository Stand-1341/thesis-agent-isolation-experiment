// Least-privilege ARM permissions for the ACI pilot controller.
// This template defines three custom roles and assigns them only to the
// named controller identity at the ACI RG, one subnet, and three explicit UAIs.
// It does not create ACI groups, modify networking, or grant role-assignment
// permissions to the controller.
targetScope = 'subscription'

@description('Resource group containing the ACI pilot network, identities, and container groups.')
param pilotResourceGroupName string
@description('Existing VNet containing the dedicated ACI subnet.')
param vnetName string
@description('Existing dedicated subnet delegated to Microsoft.ContainerInstance/containerGroups.')
param subnetName string = 'aci-experiment'
@description('Existing controller UAI attached to the experiment controller VM.')
param controllerIdentityName string = 'id-thesis-fixture-controller'
@description('Explicit UAI used only for ACR image pull by ACI groups.')
param pullIdentityName string
@description('Explicit P1 ACI workload UAI.')
param p1WorkloadIdentityName string
@description('Explicit P2 ACI workload UAI.')
param p2WorkloadIdentityName string

resource pilotResourceGroup 'Microsoft.Resources/resourceGroups@2022-09-01' existing = {
  name: pilotResourceGroupName
}
resource controllerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: controllerIdentityName
  scope: pilotResourceGroup
}
resource aciLifecycleRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, pilotResourceGroup.id, 'thesis-aci-container-group-lifecycle')
  properties: {
    roleName: 'Thesis ACI Pilot Container Group Lifecycle'
    description: 'Read, create/update, and delete ACI container groups in the thesis pilot resource group.'
    type: 'CustomRole'
    permissions: [{
      actions: [
        'Microsoft.ContainerInstance/containerGroups/read'
        'Microsoft.ContainerInstance/containerGroups/write'
        'Microsoft.ContainerInstance/containerGroups/delete'
      ]
      notActions: []
      dataActions: []
      notDataActions: []
    }]
    assignableScopes: [pilotResourceGroup.id]
  }
}

resource aciSubnetJoinRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, pilotResourceGroup.id, 'thesis-aci-subnet-join')
  properties: {
    roleName: 'Thesis ACI Pilot Subnet Join'
    description: 'Read and join only the dedicated ACI pilot subnet.'
    type: 'CustomRole'
    permissions: [{
      actions: [
        'Microsoft.Network/virtualNetworks/subnets/read'
        'Microsoft.Network/virtualNetworks/subnets/join/action'
      ]
      notActions: []
      dataActions: []
      notDataActions: []
    }]
    assignableScopes: [pilotResourceGroup.id]
  }
}

resource uaiAttachRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, pilotResourceGroup.id, 'thesis-aci-selected-uai-attach')
  properties: {
    roleName: 'Thesis ACI Pilot Selected Identity Attach'
    description: 'Read and assign only the three explicitly selected ACI pull and workload identities.'
    type: 'CustomRole'
    permissions: [{
      actions: [
        'Microsoft.ManagedIdentity/userAssignedIdentities/read'
        'Microsoft.ManagedIdentity/userAssignedIdentities/assign/action'
      ]
      notActions: []
      dataActions: []
      notDataActions: []
    }]
    assignableScopes: [pilotResourceGroup.id]
  }
}

module assignments './aci-controller-role-assignments-pilot.bicep' = {
  name: 'aciControllerPilotRoleAssignments'
  scope: pilotResourceGroup
  params: {
    vnetName: vnetName
    subnetName: subnetName
    controllerPrincipalId: controllerIdentity.properties.principalId
    pullIdentityName: pullIdentityName
    p1WorkloadIdentityName: p1WorkloadIdentityName
    p2WorkloadIdentityName: p2WorkloadIdentityName
    aciLifecycleRoleDefinitionId: aciLifecycleRole.id
    aciSubnetJoinRoleDefinitionId: aciSubnetJoinRole.id
    uaiAttachRoleDefinitionId: uaiAttachRole.id
  }
}
