// Minimal Azure-billed GPT-5 mini endpoint for the controller.
// Entra authentication is required; local API-key auth is disabled.
param location string = 'eastus'
@minLength(3)
@maxLength(64)
param accountName string
@minValue(1)
@maxValue(500)
@description('Global Standard quota in 1,000 TPM units. 25 = 25,000 TPM for sequential pilot calls.')
param capacity int = 25

resource account 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: accountName
  location: location
  kind: 'OpenAI'
  sku: { name: 'S0' }
  properties: {
    customSubDomainName: accountName
    publicNetworkAccess: 'Enabled'
    disableLocalAuth: true
  }
}

resource deployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: account
  name: 'gpt-5-mini'
  sku: {
    name: 'GlobalStandard'
    capacity: capacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: 'gpt-5-mini'
      version: '2025-08-07'
    }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}

output endpoint string = 'https://${accountName}.openai.azure.com'
output modelDeploymentName string = deployment.name
output modelVersion string = deployment.properties.model.version
output allocatedTpm int = capacity * 1000
