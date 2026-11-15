// One Functions workload route per deployment. Invoke once per P1/P2/P3 profile
// with that route's dedicated user-assigned identity, endpoint config, subnet,
// host storage account and secrets. This template attaches the workload identity;
// deployment and independent audit evidence must still prove the runtime actually
// used it. Network isolation is not asserted by this template.
param location string = resourceGroup().location
@minLength(3)
@maxLength(60)
param functionName string
param planName string
param hostStorageName string
@description('Dedicated delegated Flex integration subnet ID. Use one subnet per profile and apply its tested egress policy separately.')
param integrationSubnetId string
@description('Trusted controller public IPv4 CIDR; never a workload address.')
param controllerIpCidr string
@allowed([
  'P1'
  'P2'
  'P3'
])
param profile string
@description('Name of the existing dedicated workload UAI in this resource group for this profile.')
param workloadIdentityName string
@description('Separate identity permitted to read only this route\'s workload and trial-request secrets.')
param readerIdentityName string
param researchUrl string
param collectorUrl string
param restrictedUrl string
param fixtureBlobEndpoint string
@description('Fixture storage account resource ID followed by /blobServices/default.')
param fixtureBlobResourceId string
@description('Versionless HTTPS Key Vault URI for this route\'s workload token. Resolved by Azure, never supplied as a template value.')
param workloadTokenSecretUri string
@description('Versionless HTTPS Key Vault URI for this route\'s distinct trial-request key. Resolved by Azure, never supplied as a template value.')
param trialRequestKeySecretUri string

resource workloadIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: workloadIdentityName
}

resource secretReaderIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: readerIdentityName
}

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
    // integration subnet. This uses the existing pilot's platform-storage pattern;
    // it is not the evidence store and must remain separate from workload data.
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}
resource hostBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: hostStorage
  name: 'default'
}
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
  // Keep a system identity for the isolated Flex host/deployment storage role.
  // The user identity below is the only identity the workload selects for its
  // Azure Storage calls. Never reuse the system identity as a trial principal.
  identity: {
    type: 'SystemAssigned, UserAssigned'
    userAssignedIdentities: {
      '${workloadIdentity.id}': {}
      '${secretReaderIdentity.id}': {}
    }
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    virtualNetworkSubnetId: integrationSubnetId
    publicNetworkAccess: 'Enabled'
    keyVaultReferenceIdentity: secretReaderIdentity.id
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
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'RESEARCH_URL', value: researchUrl }
        { name: 'COLLECTOR_URL', value: collectorUrl }
        { name: 'RESTRICTED_URL', value: restrictedUrl }
        { name: 'AZURE_BLOB_ENDPOINT', value: fixtureBlobEndpoint }
        { name: 'THESIS_BLOB_RESOURCE_ID', value: fixtureBlobResourceId }
        { name: 'AZURE_CLIENT_ID', value: workloadIdentity.properties.clientId }
        { name: 'AZURE_PRINCIPAL_OBJECT_ID', value: workloadIdentity.properties.principalId }
        { name: 'NODE_EXTRA_CA_CERTS', value: '/home/site/wwwroot/certs/thesis-pilot-ca.pem' }
        { name: 'SCENARIO_PROFILE', value: profile }
        { name: 'WORKLOAD_TOKEN', value: '@Microsoft.KeyVault(SecretUri=${workloadTokenSecretUri})' }
        { name: 'TRIAL_REQUEST_KEY', value: '@Microsoft.KeyVault(SecretUri=${trialRequestKeySecretUri})' }
      ]
    }
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${hostStorage.properties.primaryEndpoints.blob}${deploymentContainer.name}'
          authentication: { type: 'SystemAssignedIdentity' }
        }
      }
      runtime: { name: 'node', version: '22' }
      scaleAndConcurrency: {
        maximumInstanceCount: 1
        instanceMemoryMB: 2048
        triggers: { http: { perInstanceConcurrency: 1 } }
      }
    }
  }
  tags: {
    experimentRoute: 'azure_functions_flex'
    experimentProfile: profile
    role: 'workload-route'
  }
}
var hostRoleIds = [
  'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
  '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
  '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
]
resource hostRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for roleId in hostRoleIds: {
  scope: hostStorage
  name: guid(hostStorage.id, app.id, roleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleId)
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
  }
}]
output functionId string = app.id
output agentUrl string = 'https://${functionName}.azurewebsites.net/api'
output workloadPrincipalId string = workloadIdentity.properties.principalId
output systemPrincipalId string = app.identity.principalId
output workloadIdentityClientId string = workloadIdentity.properties.clientId
output hostStorageId string = hostStorage.id
