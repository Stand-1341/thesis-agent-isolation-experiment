// Dedicated ACI workload identities. P1 receives its exact Blob role set in a
// separate template; P2 is created for controller-role template consistency
// but receives no workload permissions until its arm is reviewed.
targetScope = 'resourceGroup'

param location string = resourceGroup().location
param p1IdentityName string = 'id-thesis-aci-p1'
param p2IdentityName string = 'id-thesis-aci-p2'

resource p1 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: p1IdentityName
  location: location
}

resource p2 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: p2IdentityName
  location: location
}

output p1IdentityId string = p1.id
output p1ClientId string = p1.properties.clientId
output p1PrincipalId string = p1.properties.principalId
output p2IdentityId string = p2.id
output p2ClientId string = p2.properties.clientId
output p2PrincipalId string = p2.properties.principalId
