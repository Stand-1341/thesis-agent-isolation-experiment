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
param sshPublicKey string = ''
param vmImageVersion string = ''
param trustedControllerPublicIp string = '0.0.0.0/0'
param agentImageDigest string = ''
param agentRegistryName string = ''
param evidenceRetentionDays int = 7
param useExistingVnetId string = ''
param useExistingRegistryId string = ''

var enableWorkloads = stage == 'full'

module threeArm '../Complete_Thesis_Azure_Package/05-DOCKER-STARTER/infra/azure-supported-three-arm.bicep' = {
  name: 'thesis-three-arm-${stage}'
  params: {
    namePrefix: namePrefix
    location: location
    // Foundation stage never touches VMs, so an empty key is accepted by Bicep.
    // The full stage is only reachable via deploy/postprovision.mjs →
    // render-parameters.mjs, which refuses to emit anything without a real key.
    sshPublicKey: !empty(sshPublicKey) ? sshPublicKey : ''
    vmImageVersion: !empty(vmImageVersion) ? vmImageVersion : 'latest'
    trustedControllerPublicIp: trustedControllerPublicIp
    deployVmArm: enableWorkloads
    deploySandboxGroups: enableWorkloads
    deployP3Firewall: enableWorkloads
    deployEnvironmentNsg: enableWorkloads
    deployEvidenceStore: enableWorkloads
    deploySyntheticFixtures: enableWorkloads
    createRecordUpdateRole: enableWorkloads
    deployResearchHost: enableWorkloads
    deployRegistryPrivateEndpoint: enableWorkloads
    deployRegistryMetadataReader: enableWorkloads
    evidenceRetentionDays: evidenceRetentionDays
    agentImageP1: enableWorkloads && !empty(agentImageDigest) ? '${registryServerVal}.azurecr.io/thesis/agent@${agentImageDigest}' : 'docker.io/library/busybox:latest'
    agentImageP2: enableWorkloads && !empty(agentImageDigest) ? '${registryServerVal}.azurecr.io/thesis/agent@${agentImageDigest}' : 'docker.io/library/busybox:latest'
    agentImageP3: enableWorkloads && !empty(agentImageDigest) ? '${registryServerVal}.azurecr.io/thesis/agent@${agentImageDigest}' : 'docker.io/library/busybox:latest'
  }
}

// The registry server is derived from the template's own naming convention
// (param registryName defaults to '${namePrefix}acr') unless an existing
// registry is referenced by name. The template emits registryServer as an
// output, but image references must be resolvable as *inputs* on the full
// stage — hence mirroring the naming rule here.
var registryServerVal: !empty(agentRegistryName) ? agentRegistryName : '${namePrefix}acr'

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
output experimentConfigRoutes object = threeArm.outputs.experimentConfigRoutes
output researchServicePrivateIp string = threeArm.outputs.researchServicePrivateIp
output collectorPrivateIp string = threeArm.outputs.collectorPrivateIp
output evidenceAccountId string = threeArm.outputs.evidenceAccountId
output evidenceContainerUrl string = threeArm.outputs.evidenceContainerUrl
output fixtureAccountId string = threeArm.outputs.fixtureAccountId
output fixtureBlobEndpoint string = threeArm.outputs.fixtureBlobEndpoint
output sandboxDiskImageNames object = threeArm.outputs.sandboxDiskImageNames
output jobsEnvironmentId string = threeArm.outputs.jobsEnvironmentId
output jobsP3EnvironmentId string = threeArm.outputs.jobsP3EnvironmentId
