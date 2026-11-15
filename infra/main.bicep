// azd entry template. Wraps the existing three-arm experiment template
// (Complete_Thesis_Azure_Package/05-DOCKER-STARTER/infra/azure-supported-three-arm.bicep)
// without modifying it, and adds the two-stage provisioning the azd pipeline needs:
//
//   stage = 'foundation' : identities, networking, registry, log workspace,
//                          storage accounts — everything that must exist before
//                          the agent image can be built and pushed.
//   stage = 'full'       : foundation + VM arm + ACA Jobs + sandbox groups +
//                          evidence/fixture stores, pinned to the image digest
//                          resolved after stage one (AGENT_IMAGE_DIGEST).
//
// Reruns are idempotent: the underlying template is declarative, and the deploy
// hooks only act when their checkpoint state says a step has not completed.
targetScope = 'resourceGroup'

@allowed(['foundation', 'full'])
param stage string = 'foundation'

param namePrefix string = 'thesis'
param location string = resourceGroup().location
param vnetAddressPrefix string = '10.48.0.0/16'
@allowed(['functions_flex', 'aca_jobs'])
@description('Uniform serverless substrate for every profile. functions_flex uses three dedicated apps/subnets and one ACA environment for Sandboxes only; aca_jobs preserves the legacy two-environment v2 layout.')
param serverlessRuntime string = 'functions_flex'
@description('Legacy Jobs-only owner-selected non-East-US region for isolated P3 routes. Ignored by the single-region Functions Flex composition, which deliberately avoids profile-region confounding.')
param p3RegionLocation string = ''
@description('Optional distinct prefix for P3 resources in the second region. Set this when the resource group already contains same-named P3 resources in another region.')
param p3NamePrefix string = ''
@description('Reserved research listener IP in the research-services subnet; passed unchanged to the shared host and regional P3 allowlist.')
param researchServicePrivateIp string = '10.48.9.4'
@description('Reserved collector listener IP in the research-services subnet; passed unchanged to the shared host and regional P3 denylist.')
param collectorPrivateIp string = '10.48.9.5'
@description('Reserved restricted receiver listener IP in the research-services subnet; passed unchanged to the shared host and regional P3 denylist.')
param restrictedServicePrivateIp string = '10.48.9.6'
@description('Shared private DNS zone resource IDs required by the regional P3 route.')
param sharedPrivateDnsZoneResourceIds string = '[]'
param sshPublicKey string = ''
param vmImageVersion string = ''
param vmVmSize string = 'Standard_F1as_v7'
param researchHostVmSize string = 'Standard_F1as_v7'
param trustedControllerPublicIp string
@minLength(1)
@description('CIDRs permitted to reach VM workloads over HTTPS. Supply the actual controller/workload source ranges; no public default is provided.')
param controllerSourcePrefixesCsv string
@minLength(1)
@description('CIDRs permitted to reach the research service on 443. Supply actual workload source ranges.')
param researchSourcePrefixesCsv string
@minLength(1)
@description('CIDRs permitted to reach the collector on 8443. Supply actual P1/P2 workload source ranges only.')
param collectorSourcePrefixesCsv string
@minLength(1)
@description('Operator/controller CIDRs for research host administration and service access. Supply actual operator ranges.')
param operatorSourcePrefixesCsv string
param agentImageDigest string = ''
param agentRegistryName string = ''
param evidenceRetentionDays string = '7'
param useExistingVnetId string = ''
param useExistingRegistryId string = ''
@description('Object ID of the signed-in azd user. The foundation bootstrap grants this user Key Vault and lock-container data access so postprovision can seed secrets without exposing values.')
param operatorPrincipalId string
@description('Optional existing RBAC-enabled Key Vault with the nine pre-bootstrapped per-route workload-token secrets. When set, only per-secret reader assignments are created.')
param workloadTokenVaultName string = ''
param existingBootstrapVaultName string = ''
param bootstrapLockStorageAccountName string = ''
param controllerIdentityResourceName string = ''

var controllerSourcePrefixes = split(controllerSourcePrefixesCsv, ',')
var researchSourcePrefixes = split(researchSourcePrefixesCsv, ',')
var collectorSourcePrefixes = split(collectorSourcePrefixesCsv, ',')
var operatorSourcePrefixes = split(operatorSourcePrefixesCsv, ',')
var enableWorkloads = stage == 'full'
var enableFunctions = enableWorkloads && serverlessRuntime == 'functions_flex'
var deployRegionalP3 = enableWorkloads && serverlessRuntime == 'aca_jobs' && !empty(p3RegionLocation) && toLower(p3RegionLocation) != toLower(location)
var prepareRegionalP3Support = serverlessRuntime == 'aca_jobs' && !empty(p3RegionLocation) && toLower(p3RegionLocation) != toLower(location)

module bootstrap './bootstrap-prerequisites.bicep' = {
  name: 'thesis-host-bootstrap-prerequisites'
  params: {
    location: location
    namePrefix: namePrefix
    operatorPrincipalId: operatorPrincipalId
    operatorPublicIp: trustedControllerPublicIp
    existingVaultName: workloadTokenVaultName
    existingBootstrapVaultName: existingBootstrapVaultName
    lockStorageAccountName: bootstrapLockStorageAccountName
  }
}
var effectiveWorkloadTokenVaultName = !empty(workloadTokenVaultName) ? workloadTokenVaultName : bootstrap.outputs.vaultName

module threeArm '../Complete_Thesis_Azure_Package/05-DOCKER-STARTER/infra/azure-supported-three-arm.bicep' = {
  name: 'thesis-three-arm-${stage}'
  params: {
    namePrefix: namePrefix
    location: location
    vnetAddressPrefix: vnetAddressPrefix
    existingVnetId: useExistingVnetId
    registryName: registryServerVal
    controllerIdentityResourceName: empty(controllerIdentityResourceName) ? '${namePrefix}-controller' : controllerIdentityResourceName
    researchServicePrivateIp: researchServicePrivateIp
    collectorPrivateIp: collectorPrivateIp
    restrictedServicePrivateIp: restrictedServicePrivateIp
    // Foundation stage never touches VMs, so an empty key is accepted by Bicep.
    // The full stage is only reachable via deploy/postprovision.mjs →
    // render-parameters.mjs, which refuses to emit anything without a real key.
    sshPublicKey: !empty(sshPublicKey) ? sshPublicKey : ''
    vmImageVersion: !empty(vmImageVersion) ? vmImageVersion : 'latest'
    vmVmSize: vmVmSize
    researchHostVmSize: researchHostVmSize
    trustedControllerPublicIp: trustedControllerPublicIp
    controllerSourcePrefixes: controllerSourcePrefixes
    researchSourcePrefixes: researchSourcePrefixes
    collectorSourcePrefixes: collectorSourcePrefixes
    operatorSourcePrefixes: operatorSourcePrefixes
    deployVmArm: enableWorkloads
    deployJobs: enableWorkloads && !enableFunctions
    deployFunctionsArm: enableFunctions
    deploySandboxGroups: enableWorkloads
    deployP3Firewall: enableWorkloads && (enableFunctions || !deployRegionalP3)
    deployRegionalP3Support: prepareRegionalP3Support
    deployP3VmRoute: !deployRegionalP3
    deployP3SandboxGroup: !deployRegionalP3
    deployEnvironmentNsg: enableWorkloads && !enableFunctions
    deployEvidenceStore: enableWorkloads
    deploySyntheticFixtures: enableWorkloads
    createRecordUpdateRole: enableWorkloads
    deployResearchHost: enableWorkloads
    deployRegistryPrivateEndpoint: enableWorkloads
    deployRegistryMetadataReader: enableWorkloads
    linkVaultSecretReader: enableWorkloads
    vaultName: effectiveWorkloadTokenVaultName
    evidenceRetentionDays: int(evidenceRetentionDays)
    trustedPublicIpRules: [trustedControllerPublicIp]
    validationPrincipalId: operatorPrincipalId
    sandboxOperatorPrincipalId: operatorPrincipalId
    agentImageP1: enableWorkloads && !empty(agentImageDigest) ? '${registryServerVal}.azurecr.io/thesis/agent@${agentImageDigest}' : 'docker.io/library/busybox:latest'
    agentImageP2: enableWorkloads && !empty(agentImageDigest) ? '${registryServerVal}.azurecr.io/thesis/agent@${agentImageDigest}' : 'docker.io/library/busybox:latest'
    agentImageP3: enableWorkloads && !empty(agentImageDigest) ? '${registryServerVal}.azurecr.io/thesis/agent@${agentImageDigest}' : 'docker.io/library/busybox:latest'
  }
}

module regionalP3 '../Complete_Thesis_Azure_Package/05-DOCKER-STARTER/infra/regional-p3-spoke.bicep' = if (deployRegionalP3) {
  name: 'thesis-regional-p3'
  params: {
    namePrefix: !empty(p3NamePrefix) ? p3NamePrefix : namePrefix
    location: p3RegionLocation
    vnetAddressPrefix: '10.52.0.0/16'
    vmP3SubnetPrefix: '10.52.2.0/24'
    jobsP3EnvironmentSubnetPrefix: '10.52.12.0/27'
    firewallSubnetPrefix: '10.52.0.0/26'
    firewallManagementSubnetPrefix: '10.52.0.64/26'
    controllerSourcePrefixes: controllerSourcePrefixes
    researchServicePrivateIp: researchServicePrivateIp
    collectorPrivateIp: collectorPrivateIp
    restrictedServicePrivateIp: restrictedServicePrivateIp
    fixtureEndpointPrivateIp: threeArm.outputs.regionalNetworkSupport.fixtureEndpointPrivateIp
    evidenceEndpointPrivateIp: threeArm.outputs.regionalNetworkSupport.evidenceEndpointPrivateIp
    logAnalyticsWorkspaceId: threeArm.outputs.logWorkspaceId
    sharedHubVnetResourceId: threeArm.outputs.virtualNetworkId
    sharedHubRouteTableResourceId: threeArm.outputs.regionalNetworkSupport.serviceReturnRouteTableId
    sharedHubPrivateEndpointRouteTableResourceId: threeArm.outputs.regionalNetworkSupport.privateEndpointReturnRouteTableId
    sharedPrivateDnsZoneResourceIds: concat(
      empty(threeArm.outputs.regionalNetworkSupport.blobPrivateDnsZoneId) ? [] : [threeArm.outputs.regionalNetworkSupport.blobPrivateDnsZoneId],
      empty(threeArm.outputs.regionalNetworkSupport.registryPrivateDnsZoneId) ? [] : [threeArm.outputs.regionalNetworkSupport.registryPrivateDnsZoneId],
      json(sharedPrivateDnsZoneResourceIds))
    registryFqdn: '${registryServerVal}.azurecr.io'
    logWorkspaceResourceId: threeArm.outputs.logWorkspaceId
    agentImageP3: enableWorkloads && !empty(agentImageDigest) ? '${registryServerVal}.azurecr.io/thesis/agent@${agentImageDigest}' : 'docker.io/library/busybox:latest'
    vmWorkloadIdentityName: last(split(threeArm.outputs.experimentConfigRoutes.azure_vm.P3.workloadIdentityResourceId, '/'))
    vmReaderUaiName: last(split(threeArm.outputs.experimentConfigRoutes.azure_vm.P3.secretReaderIdentityResourceId, '/'))
    jobsWorkloadIdentityResourceId: threeArm.outputs.jobP3WorkloadIdentityResourceId
    jobsWorkloadIdentityClientId: threeArm.outputs.jobP3WorkloadClientId
    jobsWorkloadPrincipalId: threeArm.outputs.jobP3WorkloadObjectId
    jobsReaderIdentityResourceId: threeArm.outputs.routeSecretReaderIdentities.aca_jobs.P3.resourceId
    jobsReaderIdentityClientId: threeArm.outputs.routeSecretReaderIdentities.aca_jobs.P3.clientId
    imagePullIdentityResourceId: threeArm.outputs.imagePullIdentityResourceId
    sandboxControlIdentityResourceId: threeArm.outputs.sandboxControlIdentityResourceId
    sandboxControlPrincipalId: threeArm.outputs.sandboxControlIdentityObjectId
    vmImageVersion: !empty(vmImageVersion) ? vmImageVersion : 'latest'
    sshPublicKey: sshPublicKey
  }
}

// The registry server is derived from the template's own naming convention
// (param registryName defaults to '${namePrefix}acr') unless an existing
// registry is referenced by name. The template emits registryServer as an
// output, but image references must be resolvable as *inputs* on the full
// stage — hence mirroring the naming rule here.
var registryServerVal = !empty(agentRegistryName) ? agentRegistryName : '${namePrefix}acr'

output stage string = stage
output virtualNetworkId string = threeArm.outputs.virtualNetworkId
output registryServer string = threeArm.outputs.registryServer
output logWorkspaceId string = threeArm.outputs.logWorkspaceId
output imagePullIdentityResourceId string = threeArm.outputs.imagePullIdentityResourceId
output controllerIdentityClientId string = threeArm.outputs.controllerIdentityClientId
output controllerIdentityObjectId string = threeArm.outputs.controllerIdentityObjectId
output verifierIdentityObjectId string = threeArm.outputs.verifierIdentityObjectId
output secretReaderIdentityObjectId string = threeArm.outputs.secretReaderIdentityObjectId
output fixtureOwnerIdentityObjectId string = threeArm.outputs.fixtureOwnerIdentityObjectId
output sandboxControlIdentityClientId string = threeArm.outputs.sandboxControlIdentityClientId
var regionalRoutes = deployRegionalP3 ? {
  azure_vm: union(threeArm.outputs.experimentConfigRoutes.azure_vm, { P3: union(threeArm.outputs.experimentConfigRoutes.azure_vm.P3, { resourceId: regionalP3!.outputs.vmP3ResourceId }) })
  aca_jobs: union(threeArm.outputs.experimentConfigRoutes.aca_jobs, { P3: union(threeArm.outputs.experimentConfigRoutes.aca_jobs.P3, { resourceId: regionalP3!.outputs.jobP3ResourceId }) })
  aca_sandboxes: union(threeArm.outputs.experimentConfigRoutes.aca_sandboxes, { P3: union(threeArm.outputs.experimentConfigRoutes.aca_sandboxes.P3, { sandboxGroupId: regionalP3!.outputs.sandboxGroupP3ResourceId }) })
} : threeArm.outputs.experimentConfigRoutes
output experimentConfigRoutes object = regionalRoutes
var serverlessRouteRegions = serverlessRuntime == 'functions_flex'
  ? { azure_functions_flex: { P1: location, P2: location, P3: location } }
  : { aca_jobs: { P1: location, P2: location, P3: deployRegionalP3 ? p3RegionLocation : location } }
output routeRegions object = union({
  azure_vm: { P1: location, P2: location, P3: deployRegionalP3 ? p3RegionLocation : location }
  aca_sandboxes: { P1: location, P2: location, P3: deployRegionalP3 ? p3RegionLocation : location }
}, serverlessRouteRegions)
output researchServicePrivateIp string = threeArm.outputs.researchServicePrivateIp
output collectorPrivateIp string = threeArm.outputs.collectorPrivateIp
output restrictedServicePrivateIp string = threeArm.outputs.restrictedServicePrivateIp
output restrictedServicePolicyIp string = threeArm.outputs.restrictedServicePolicyIp
output researchHostResourceId string = threeArm.outputs.researchHostResourceId
output researchHostSecretReaderClientId string = threeArm.outputs.researchHostSecretReaderClientId
output evidenceAccountId string = threeArm.outputs.evidenceAccountId
output evidenceContainerUrl string = threeArm.outputs.evidenceContainerUrl
output workloadTokenVaultName string = effectiveWorkloadTokenVaultName
output bootstrapLockBlobUrl string = bootstrap.outputs.lockBlobUrl
output bootstrapStorageAccountName string = bootstrap.outputs.lockStorageAccountName
output fixtureAccountId string = threeArm.outputs.fixtureAccountId
output fixtureBlobEndpoint string = threeArm.outputs.fixtureBlobEndpoint
output fixtureBlobResourceId string = threeArm.outputs.fixtureBlobResourceId
output sandboxDiskImageNames object = threeArm.outputs.sandboxDiskImageNames
output sandboxGroupRuntimeSpecs object = threeArm.outputs.sandboxGroupRuntimeSpecs
output jobsEnvironmentId string = threeArm.outputs.jobsEnvironmentId
output jobsP3EnvironmentId string = deployRegionalP3 ? regionalP3!.outputs.jobsP3EnvironmentId : threeArm.outputs.jobsP3EnvironmentId
output vmP3ResourceId string = deployRegionalP3 ? regionalP3!.outputs.vmP3ResourceId : threeArm.outputs.vmP3ResourceId
output vmP3WorkloadObjectId string = deployRegionalP3 ? regionalP3!.outputs.vmP3WorkloadObjectId : threeArm.outputs.vmP3WorkloadObjectId
output jobP3ResourceId string = deployRegionalP3 ? regionalP3!.outputs.jobP3ResourceId : threeArm.outputs.jobP3ResourceId
output sandboxGroupP3ResourceId string = deployRegionalP3 ? regionalP3!.outputs.sandboxGroupP3ResourceId : threeArm.outputs.sandboxGroupP3ResourceId
