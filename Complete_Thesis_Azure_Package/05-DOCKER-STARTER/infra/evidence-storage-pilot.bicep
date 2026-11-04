// Candidate evidence store. Without explicit IP rules it is unreachable over
// the public endpoint; operators can use a private endpoint instead. Blob
// Data Contributor can overwrite/delete data: conditional writes alone are
// NOT immutable storage. Provision a tested retention policy separately.
param location string = resourceGroup().location
@minLength(3)
@maxLength(24)
param storageName string
@description('Object ID of the trusted controller principal; never a workload principal.')
param writerPrincipalId string
@description('Object ID of a separately controlled verifier principal.')
param readerPrincipalId string
@description('Object ID allowed to read sensitive run-to-session mappings; never a workload principal.')
param sessionRegistryReaderPrincipalId string
param containerName string = 'trial-evidence'
@minValue(1)
@description('Retention duration in days approved for this research evidence by the institutional records policy. This value is required; do not guess it.')
param evidenceRetentionDays int
@description('Optional public IPv4 addresses or CIDRs for trusted controller/verifier access; do not include workloads.')
param trustedPublicIpRules array = []

resource account 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    accessTier: 'Hot'
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'None'
      ipRules: [for ip in trustedPublicIpRules: { action: 'Allow', value: ip }]
    }
  }
}
resource service 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: account
  name: 'default'
  properties: {
    isVersioningEnabled: true
    deleteRetentionPolicy: { enabled: true, days: 7 }
  }
}
resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: service
  name: containerName
  properties: { publicAccess: 'None' }
}
// The policy is initially Unlocked. Before measured collection, lock it with
// an ETag after verifying writer/read access and overwrite/delete rejection.
// A Locked policy cannot be shortened or deleted before expiration.
resource evidenceImmutability 'Microsoft.Storage/storageAccounts/blobServices/containers/immutabilityPolicies@2023-05-01' = {
  parent: container
  name: 'default'
  properties: {
    allowProtectedAppendWrites: false
    immutabilityPeriodSinceCreationInDays: evidenceRetentionDays
  }
}
resource sessionRegistry 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: service
  name: 'session-mappings'
  properties: { publicAccess: 'None' }
}
resource writer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: container
  name: guid(container.id,writerPrincipalId,'blob-contributor')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions','ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalId: writerPrincipalId
  }
}
resource reader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: container
  name: guid(container.id,readerPrincipalId,'blob-reader')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions','2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')
    principalId: readerPrincipalId
  }
}
resource sessionWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: sessionRegistry
  name: guid(sessionRegistry.id,writerPrincipalId,'session-blob-contributor')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions','ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalId: writerPrincipalId
  }
}
resource sessionReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: sessionRegistry
  name: guid(sessionRegistry.id,sessionRegistryReaderPrincipalId,'session-blob-reader')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions','2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')
    principalId: sessionRegistryReaderPrincipalId
  }
}
output accountId string = account.id
output containerUrl string = '${account.properties.primaryEndpoints.blob}${containerName}'
output containerResourceId string = container.id
output immutabilityPolicyId string = evidenceImmutability.id
output sessionRegistryUrl string = '${account.properties.primaryEndpoints.blob}${sessionRegistry.name}'
