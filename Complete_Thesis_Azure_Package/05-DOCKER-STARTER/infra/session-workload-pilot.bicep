// Candidate custom-container workload pool, not a validated P3 boundary.
// The pool must use a separately tested egress policy and safe session lifecycle.
// Its pull identity is NOT a session executor and must be unavailable to code.
param location string = resourceGroup().location
@minLength(3)
@maxLength(63)
@description('3-63 characters. The published swagger for Microsoft.App/sessionPools declares the pattern ^[a-z][a-z0-9]*$, which a hyphenated name violates, and bicep emits BCP416 for a literal such as thesis-session-pool. That pattern is not enforced in practice: this pilot created the hyphenated pool thesis-diag-pool successfully (EXPERIMENT-STATUS.md). Length is checked here; the pattern is left to the service.')
param poolName string
param environmentId string
param pullIdentityId string
param registryServer string
@description('Immutable digest reference of the built workload image.')
param imageDigestReference string
@description('Object ID of trusted pool controller; never a workload identity.')
param controllerPrincipalId string
param researchUrl string
param collectorUrl string
param fixtureBlobEndpoint string
@secure()
param trialRequestKey string

resource pool 'Microsoft.App/sessionPools@2026-01-01' = {
  name: poolName
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${pullIdentityId}': {} } }
  properties: {
    environmentId: environmentId
    poolManagementType: 'Dynamic'
    containerType: 'CustomContainer'
    scaleConfiguration: { maxConcurrentSessions: 2, readySessionInstances: 1 }
    dynamicPoolConfiguration: { lifecycleConfiguration: { lifecycleType: 'Timed', cooldownPeriodInSeconds: 300 } }
    customContainerTemplate: {
      registryCredentials: { server: registryServer, identity: pullIdentityId }
      containers: [{
        name: 'workload'
        image: imageDigestReference
        resources: { cpu: json('0.5'), memory: '1Gi' }
        env: [
          { name: 'RESEARCH_URL', value: researchUrl }
          { name: 'COLLECTOR_URL', value: collectorUrl }
          { name: 'AZURE_BLOB_ENDPOINT', value: fixtureBlobEndpoint }
          { name: 'AZURE_TOKEN_MODE', value: 'delegated' }
          { name: 'TRIAL_REQUEST_KEY', secretRef: 'trial-request-key' }
        ]
      }]
      ingress: { targetPort: 8080 }
    }
    secrets: [{ name: 'trial-request-key', value: trialRequestKey }]
    sessionNetworkConfiguration: { status: 'EgressEnabled' }
    managedIdentitySettings: [{ identity: pullIdentityId, lifecycle: 'None' }]
  }
}
resource executor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: pool
  name: guid(pool.id,controllerPrincipalId,'trusted-executor')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions','0fb8eba5-a2bb-4abe-b1c1-49dfad359bb0')
    principalId: controllerPrincipalId
  }
}
output poolId string = pool.id
output managementEndpoint string = pool.properties.poolManagementEndpoint
