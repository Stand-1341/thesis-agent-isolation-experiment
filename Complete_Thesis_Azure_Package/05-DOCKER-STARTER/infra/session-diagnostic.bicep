// Disposable header diagnostic only, NOT the experiment session pool.
// Requires an existing environment, private registry/image and pull-only identity.
// Identity non-exposure must be verified; lifecycle setting alone is not proof.
param location string = resourceGroup().location
@minLength(3)
@maxLength(63)
@description('3-63 characters. The published swagger for Microsoft.App/sessionPools declares the pattern ^[a-z][a-z0-9]*$, which a hyphenated name violates, and bicep emits BCP416 for a literal such as thesis-session-pool. That pattern is not enforced in practice: this pilot created the hyphenated pool thesis-diag-pool successfully (EXPERIMENT-STATUS.md). Length is checked here; the pattern is left to the service.')
param poolName string
param environmentId string
param pullIdentityId string
param registryServer string
@description('Immutable digest reference of the trusted header-audit image.')
param imageDigestReference string
@allowed(['EgressDisabled', 'EgressEnabled'])
param sessionNetworkStatus string = 'EgressDisabled'
param researchProbeUrl string = 'http://10.48.9.4:443/health'
param collectorProbeUrl string = 'http://10.48.9.5:8443/health'
param blobProbeUrl string
param publicIpProbeHost string = '1.1.1.1'
@minValue(1)
@maxValue(65535)
param publicIpProbePort int = 443

resource pool 'Microsoft.App/sessionPools@2026-01-01' = {
  name: poolName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${pullIdentityId}': {} }
  }
  properties: {
    environmentId: environmentId
    poolManagementType: 'Dynamic'
    containerType: 'CustomContainer'
    scaleConfiguration: { maxConcurrentSessions: 1, readySessionInstances: 1 }
    dynamicPoolConfiguration: { lifecycleConfiguration: { lifecycleType: 'Timed', cooldownPeriodInSeconds: 300 } }
    customContainerTemplate: {
      registryCredentials: { server: registryServer, identity: pullIdentityId }
      containers: [{
        name: 'header-audit'
        image: imageDigestReference
        resources: { cpu: json('0.5'), memory: '1Gi' }
        env: [
          { name: 'P3_RESEARCH_PROBE_URL', value: researchProbeUrl }
          { name: 'P3_COLLECTOR_PROBE_URL', value: collectorProbeUrl }
          { name: 'P3_BLOB_PROBE_URL', value: blobProbeUrl }
          { name: 'P3_PUBLIC_IP_PROBE_HOST', value: publicIpProbeHost }
          { name: 'P3_PUBLIC_IP_PROBE_PORT', value: string(publicIpProbePort) }
        ]
      }]
      ingress: { targetPort: 8080 }
    }
    sessionNetworkConfiguration: { status: sessionNetworkStatus }
    managedIdentitySettings: [{ identity: pullIdentityId, lifecycle: 'None' }]
  }
}

output poolId string = pool.id
output managementEndpoint string = pool.properties.poolManagementEndpoint
