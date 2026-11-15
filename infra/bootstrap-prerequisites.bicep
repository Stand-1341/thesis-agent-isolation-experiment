// Azure-side prerequisites for the host secret bootstrap. This is a small,
// separate vault and a lock-only storage container; the measured-evidence
// storage account remains in the full stage and has its own retention policy.
targetScope = 'resourceGroup'

param location string
@minLength(3)
@maxLength(12)
param namePrefix string
@description('Existing prerequisite vault name when reconciling a prior deployment created in another region.')
param existingBootstrapVaultName string = ''
param lockStorageAccountName string = ''
@description('User principal that runs azd and the one-time Key Vault/Blob bootstrap.')
param operatorPrincipalId string
@description('Exact operator public IPv4 CIDR allowed to use the lock container, normally a /32.')
param operatorPublicIp string
@description('Optional existing RBAC-enabled Key Vault. When empty, this module creates a dedicated vault and grants the operator Key Vault Secrets Officer on that vault only.')
param existingVaultName string = ''

var suffix = uniqueString(subscription().id, resourceGroup().id)
var generatedVaultName = !empty(existingBootstrapVaultName) ? existingBootstrapVaultName : '${toLower(take(replace(namePrefix, '-', ''), 8))}${suffix}kv'
var lockStorageName = !empty(lockStorageAccountName) ? lockStorageAccountName : '${toLower(take(replace(namePrefix, '-', ''), 7))}${suffix}bsl'
var secretsOfficerRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')
var blobDataContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')

resource createdBootstrapVault 'Microsoft.KeyVault/vaults@2023-07-01' = if (empty(existingBootstrapVaultName) && empty(existingVaultName)) {
  name: generatedVaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
    networkAcls: { bypass: 'None', defaultAction: 'Allow', ipRules: [], virtualNetworkRules: [] }
  }
  tags: { purpose: 'thesis-bootstrap-secrets', managedBy: 'azd' }
}

resource operatorVaultRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (empty(existingVaultName) && empty(existingBootstrapVaultName)) {
  name: guid(createdBootstrapVault.id, operatorPrincipalId, secretsOfficerRoleId)
  scope: createdBootstrapVault
  properties: {
    roleDefinitionId: secretsOfficerRoleId
    principalId: operatorPrincipalId
  }
}

resource lockStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: lockStorageName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  tags: { purpose: 'thesis-bootstrap-lock-only', managedBy: 'azd' }
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'None'
      defaultAction: 'Deny'
      // Storage firewall ipRules accept a bare IPv4 address, while the
      // deployment input is deliberately validated and carried as a /32.
      ipRules: [{ value: first(split(operatorPublicIp, '/')), action: 'Allow' }]
      virtualNetworkRules: []
    }
  }
}

resource lockBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: lockStorage
  name: 'default'
}

resource lockContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: lockBlobService
  name: 'bootstrap-locks'
  properties: { publicAccess: 'None' }
}

resource operatorLockRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(lockContainer.id, operatorPrincipalId, blobDataContributorRoleId)
  scope: lockContainer
  properties: {
    roleDefinitionId: blobDataContributorRoleId
    principalId: operatorPrincipalId
  }
}

output vaultName string = !empty(existingBootstrapVaultName) ? existingBootstrapVaultName : empty(existingVaultName) ? generatedVaultName : existingVaultName
output lockBlobUrl string = 'https://${lockStorage.name}.blob.${environment().suffixes.storage}/bootstrap-locks/three-arm-secret-bootstrap.lock'
output lockStorageAccountName string = lockStorage.name
