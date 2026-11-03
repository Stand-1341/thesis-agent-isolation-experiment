// Deploy in the Network Watcher's resource group. Log coverage for the
// managed workloads and correlation to denials must be proven in a pilot.
param location string
param watcherName string
param flowLogName string
param targetVnetId string
@description('Existing private, access-controlled storage account resource ID in the same region.')
param storageId string
@description('Dedicated managed identity with write access only to the flow-log storage account.')
param writerIdentityId string
@minValue(1)
@maxValue(365)
param retentionDays int = 30

resource watcher 'Microsoft.Network/networkWatchers@2024-10-01' existing = { name: watcherName }
resource flowLog 'Microsoft.Network/networkWatchers/flowLogs@2024-10-01' = {
  parent: watcher
  name: flowLogName
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${writerIdentityId}': {} } }
  properties: {
    targetResourceId: targetVnetId
    storageId: storageId
    enabled: true
    retentionPolicy: { enabled: true, days: retentionDays }
    format: { type: 'JSON', version: 2 }
  }
}
output flowLogId string = flowLog.id
