// Phase 1 trusted bootstrap: create deterministic UAI resources only.
// Principal IDs must be read from ARM before the phase-2 RBAC template runs.
targetScope = 'resourceGroup'
@description('Identity specs from a manifest whose schedule digest was checked.')
@minLength(1)
param identitySpecs array

resource runIdentities 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = [for spec in identitySpecs: {
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

output createdIdentityNames array = [for spec in identitySpecs: spec.name]
output identityCount int = length(identitySpecs)
