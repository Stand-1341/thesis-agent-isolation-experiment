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
    // BLOCKER, not a finished configuration: custom container session pools require a
    // workload-profiles-enabled environment, i.e. at least one Dedicated profile such
    // as { name: 'e16', workloadProfileType: 'E16' }. A Consumption-only environment
    // cannot host the CustomContainer pools that session-workload-pilot.bicep and
    // session-diagnostic.bicep create, and the subnet here is delegated to
    // Microsoft.App/environments, which the Consumption-only shape does not want.
    // A Dedicated E16 profile is 16 vCPU / 128 GiB of reserved, billable capacity and
    // needs its own quota, so it is NOT added here silently — that is a budget and
    // quota decision for the author. Add it at environment creation; workload profiles
    // can only be introduced on an environment that supports them from the start.
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
  }
}
output environmentId string = environment.id
