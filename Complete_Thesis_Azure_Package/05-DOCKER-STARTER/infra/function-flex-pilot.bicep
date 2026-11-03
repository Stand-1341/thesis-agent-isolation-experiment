// Candidate single-profile Flex app. ARM compilation is not deployment or
// validation. Host storage privileges are exposed to this app's identity and
// must be included in the threat model; use a separate host account per app.
param location string = resourceGroup().location
param functionName string
param planName string
param hostStorageName string
@description('Dedicated delegated Flex subnet with the Microsoft.Storage service endpoint.')
param integrationSubnetId string
@description('Trusted controller public IPv4 CIDR; never a workload address.')
param controllerIpCidr string
param researchUrl string
param collectorUrl string
param fixtureBlobEndpoint string
@secure()
param workloadToken string
@secure()
param trialRequestKey string

resource hostStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: hostStorageName
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Enabled'
    // Flex host/deployment traffic originates from the platform, outside the
    // integration subnet, so a subnet-scoped virtualNetworkRule cannot authorize it
    // and a Deny default would strand the app. This mirrors the published Flex
    // Consumption reference sample
    // (github.com/Azure-Samples/azure-functions-flex-consumption-samples, IaC/bicep/main.bicep):
    // defaultAction Allow with the AzureServices bypass, shared keys off, public blob
    // access off, identity-only authentication. Reaching this account from the
    // workload network is still denied by the workload NSG. To close public access
    // entirely, add private endpoints for blob/queue/table in the
    // evidence-private-endpoints subnet plus their private DNS zones — that is an
    // additional billable resource set and is not deployed here.
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}
resource hostBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = { parent: hostStorage, name: 'default' }
resource deploymentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: hostBlobService
  name: 'deployment-packages'
  properties: { publicAccess: 'None' }
}
resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: planName
  location: location
  kind: 'functionapp'
  sku: { name: 'FC1', tier: 'FlexConsumption' }
  properties: { reserved: true }
}
resource app 'Microsoft.Web/sites@2023-12-01' = {
  name: functionName
  location: location
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    virtualNetworkSubnetId: integrationSubnetId
    publicNetworkAccess: 'Enabled'
    siteConfig: {
      minTlsVersion: '1.2'
      ipSecurityRestrictionsDefaultAction: 'Deny'
      scmIpSecurityRestrictionsUseMain: true
      ipSecurityRestrictions: [{ name: 'trusted-controller', priority: 100, action: 'Allow', ipAddress: controllerIpCidr }]
      appSettings: [
        { name: 'AzureWebJobsStorage__credential', value: 'managedidentity' }
        { name: 'AzureWebJobsStorage__blobServiceUri', value: hostStorage.properties.primaryEndpoints.blob }
        { name: 'AzureWebJobsStorage__queueServiceUri', value: hostStorage.properties.primaryEndpoints.queue }
        { name: 'AzureWebJobsStorage__tableServiceUri', value: hostStorage.properties.primaryEndpoints.table }
        { name: 'RESEARCH_URL', value: researchUrl }
        { name: 'COLLECTOR_URL', value: collectorUrl }
        { name: 'AZURE_BLOB_ENDPOINT', value: fixtureBlobEndpoint }
        { name: 'WORKLOAD_TOKEN', value: workloadToken }
        { name: 'TRIAL_REQUEST_KEY', value: trialRequestKey }
      ]
    }
    functionAppConfig: {
      deployment: { storage: { type: 'blobContainer', value: '${hostStorage.properties.primaryEndpoints.blob}${deploymentContainer.name}', authentication: { type: 'SystemAssignedIdentity' } } }
      runtime: { name: 'node', version: '22' }
      scaleAndConcurrency: { maximumInstanceCount: 1, instanceMemoryMB: 2048 }
    }
  }
}
var hostRoleIds=[
  'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
  '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
  '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
]
resource hostRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for roleId in hostRoleIds: {
  scope: hostStorage
  name: guid(hostStorage.id,app.id,roleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions',roleId)
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
  }
}]
output functionId string = app.id
output workloadPrincipalId string = app.identity.principalId
output hostStorageId string = hostStorage.id
