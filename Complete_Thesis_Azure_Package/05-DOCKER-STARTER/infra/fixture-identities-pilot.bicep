// Distinct pilot principals only. Assignments and effective access must be
// validated independently; no workload should receive controller identities.
param location string = resourceGroup().location
param prefix string = 'id-thesis-fixture'

var workloadNames = ['vm-p1', 'functions-p1', 'sessions-p1', 'vm-p2', 'vm-p3', 'functions-p2', 'functions-p3', 'sessions-p2', 'sessions-p3']
var trustedNames = ['controller', 'verifier', 'session-owner']

resource workload 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = [for name in workloadNames: {
  name: '${prefix}-${name}'
  location: location
}]
resource trusted 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = [for name in trustedNames: {
  name: '${prefix}-${name}'
  location: location
}]

output p1PrincipalIds array = [for i in range(0, 3): workload[i].properties.principalId]
output restrictedPrincipalIds array = [for i in range(3, 6): workload[i].properties.principalId]
output fixtureControllerPrincipalId string = trusted[0].properties.principalId
output verifierPrincipalId string = trusted[1].properties.principalId
output sessionFixtureOwnerPrincipalId string = trusted[2].properties.principalId
