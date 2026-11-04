// One private ACI agent group for a bounded, non-counted setup pilot.
// This is not the per-trial controller/cleanup adapter and must not be used
// for measured rows until that lifecycle is implemented and validated.
param location string = resourceGroup().location
@minLength(3)
@maxLength(63)
@description('Use a unique lowercase name. Delete the group after the setup check.')
param containerGroupName string
param subnetId string
param imageDigestReference string
param registryServer string
param pullIdentityId string
param workloadIdentityId string
param workloadIdentityClientId string
param workloadPrincipalObjectId string
param blobResourceId string
param researchUrl string
param collectorUrl string
param blobEndpoint string
@secure()
param workloadToken string
@secure()
param trialRequestKey string
@description('Pilot resource use is fixed at one vCPU and 1.5 GiB.')
param cpu int = 1
param memoryInGiB string = '1.5'
@description('ACI does not inherit VNet DNS settings. Use the VNet resolver explicitly.')
param dnsServer string = '168.63.129.16'

resource group 'Microsoft.ContainerInstance/containerGroups@2023-05-01' = {
  name: containerGroupName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${pullIdentityId}': {}
      '${workloadIdentityId}': {}
    }
  }
  properties: {
    containers: [{
      name: 'agent'
      properties: {
        image: imageDigestReference
        ports: [{ port: 8080, protocol: 'TCP' }]
        resources: { requests: { cpu: cpu, memoryInGB: json(memoryInGiB) } }
        environmentVariables: [
          { name: 'PORT', value: '8080' }
          { name: 'AZURE_TOKEN_MODE', value: 'managed' }
          { name: 'AZURE_CLIENT_ID', value: workloadIdentityClientId }
          { name: 'AZURE_PRINCIPAL_OBJECT_ID', value: workloadPrincipalObjectId }
          { name: 'THESIS_BLOB_RESOURCE_ID', value: blobResourceId }
          { name: 'AZURE_BLOB_ENDPOINT', value: blobEndpoint }
          { name: 'RESEARCH_URL', value: researchUrl }
          { name: 'COLLECTOR_URL', value: collectorUrl }
          { name: 'WORKLOAD_TOKEN', secureValue: workloadToken }
          { name: 'TRIAL_REQUEST_KEY', secureValue: trialRequestKey }
        ]
      }
    }]
    imageRegistryCredentials: [{ server: registryServer, identity: pullIdentityId }]
    ipAddress: {
      type: 'Private'
      ports: [{ port: 8080, protocol: 'TCP' }]
    }
    osType: 'Linux'
    restartPolicy: 'Never'
    sku: 'Standard'
    subnetIds: [{ id: subnetId }]
    dnsConfig: { nameServers: [dnsServer] }
  }
}

output containerGroupId string = group.id
output privateIp string = group.properties.ipAddress.ip
output provisioningState string = group.properties.provisioningState
