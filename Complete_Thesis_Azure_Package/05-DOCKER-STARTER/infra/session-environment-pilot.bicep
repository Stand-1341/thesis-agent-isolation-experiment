// Environment skeleton only. It supplies no egress rules or independent
// network logs and must not be used for measured trials without pilot gates.
param location string = resourceGroup().location
param environmentName string
param tags object = { Study: 'AzureThesisExperiment', Phase: 'Pilot' }
param infrastructureSubnetId string
@description('Existing Log Analytics workspace customer ID.')
param logCustomerId string
param workspaceName string

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
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
  }
}
output environmentId string = environment.id
