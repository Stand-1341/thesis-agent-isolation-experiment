// Environment skeleton only. It supplies no egress rules or independent
// network logs and must not be used for measured trials without pilot gates.
param location string = resourceGroup().location
param environmentName string
param tags object = { Study: 'AzureThesisExperiment', Phase: 'Pilot' }
param infrastructureSubnetId string
@description('Existing Log Analytics workspace customer ID.')
param logCustomerId string
param workspaceName string
@minValue(0)
@maxValue(1)
@description('Minimum E16 instances. Keep at zero to avoid reserving an idle dedicated node; a ready custom session still allocates E16 capacity and is billable.')
param sessionE16MinimumCount int = 0
@minValue(1)
@maxValue(1)
@description('Maximum E16 instances. This pilot is intentionally capped at one node; confirm regional quota and eligible-credit cost before creating a session pool.')
param sessionE16MaximumCount int = 1

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = { name: workspaceName }

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: { customerId: logCustomerId, sharedKey: workspace.listKeys().primarySharedKey }
    }
    vnetConfiguration: { infrastructureSubnetId: infrastructureSubnetId, internal: false }
    // Custom-container session pools require a workload-profiles environment and
    // dedicated E16 capacity. A new environment may be required: a legacy
    // Consumption-only environment cannot be converted in place. One ready session
    // can allocate this E16 profile, so only deploy after checking quota and eligible
    // credit. The cap prevents an accidental multi-node scale-out during the pilot.
    workloadProfiles: [
      { name: 'Consumption', workloadProfileType: 'Consumption' }
      {
        name: 'session-e16'
        workloadProfileType: 'E16'
        minimumCount: sessionE16MinimumCount
        maximumCount: sessionE16MaximumCount
      }
    ]
  }
}
output environmentId string = environment.id
