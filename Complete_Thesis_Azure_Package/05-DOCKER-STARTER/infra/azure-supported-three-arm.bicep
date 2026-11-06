// ============================================================================
// Azure three-arm supported-architecture composition (NOT DEPLOYED, NOT VALIDATED)
// ============================================================================
// Target: thesis three-arm comparison (docs/AZURE-SUPPORTED-THREE-ARM-ARCHITECTURE.md)
//   Arm 1 - traditional VM: per-profile private VMs (reuses vm-route.bicep)
//   Arm 2 - serverless: ACA Jobs on a workload-profiles environment, Consumption
//           workload profile (reuses session-environment-pilot.bicep, new Jobs)
//   Arm 3 - microVM (vendor-attested term): ACA Sandboxes sandbox groups
//           (stable Microsoft.App/sandboxGroups@2026-07-01 control plane only)
//
// STATUS AND HONESTY BOUNDARIES (do not weaken these when editing):
//   1. This file has never been deployed. Offline compilation is the only
//      verification performed.
//   2. Workload-profiles environments + UDR egress are documented platform
//      features (learn.microsoft.com/azure/container-apps/user-defined-routes -
//      "only supported for the default workload profiles environment type");
//      that a *job execution's* outbound packets traverse the UDR is a
//      NON-COUNTED PILOT GATE, not a verified fact.
//   3. Microsoft.App/sandboxGroups@2026-07-01 is the STABLE control-plane API
//      (learn.microsoft.com/azure/templates/microsoft.app/sandboxgroups):
//      location/name/tags/properties.environmentId ONLY. Group identity,
//      sandbox resource defaults, vnetConnections and egress policies exist on
//      the PREVIEW tier (2026-02-01-preview quickstart:
//      learn.microsoft.com/azure/container-apps/sandboxes-quickstart-bicep) and
//      in the preview data plane. They are carried here as parameters/outputs
//      for that client and are deliberately NOT written into the stable
//      resource - adding them there would fabricate schema.
//   4. Sandbox disk images are created through the data-plane client
//      (sandboxes.azure.com/docs/sandboxes/disk-images) from the pinned OCI
//      image. They are NOT ARM/Bicep resources and are not pretended to be.
//   5. Expensive/optional components (Azure Firewall stack, second environment,
//      P3 job, evidence/fixtures stores, private endpoints, VM arm, research
//      host, sandbox groups, vault link) are gated behind boolean parameters
//      defaulting to false; only the identity set, registry/workspace, network
//      skeleton, P1/P2 environments/jobs and controller RBAC always compile.
//   6. The trusted controller gets a custom role with EXACTLY the verified ARM
//      actions for start/read. Built-in Contributor / Container Apps Jobs
//      Operator are deliberately NOT used; their wildcards would also match
//      Microsoft.App/jobs/listSecrets/action. Action sources (REST 2026-07-01):
//        POST .../providers/Microsoft.App/jobs/{name}/start        -> jobs/start/action
//        GET  .../providers/Microsoft.App/jobs/{name}/executions   -> jobs/executions/read
//        GET  .../providers/Microsoft.App/jobs/{name}/executions/x -> jobs/executions/read
//        GET  .../providers/Microsoft.App/jobs/{name}              -> jobs/read
//      learn.microsoft.com/rest/api/resource-manager/containerapps/jobs/start?view=rest-resource-manager-containerapps-2026-07-01
//      learn.microsoft.com/rest/api/resource-manager/containerapps/jobs-executions/list?view=rest-resource-manager-containerapps-2026-07-01
//      learn.microsoft.com/rest/api/resource-manager/containerapps/job-execution/job-execution?view=rest-resource-manager-containerapps-2026-07-01
//   7. The VNet is defined in this file (not by reusing network-pilot.bicep)
//      because a single deployment cannot attach route tables / NSGs to
//      subnets another module creates inline, and P3 egress symmetry
//      (workload -> firewall -> service and service -> firewall -> workload)
//      requires owning the subnet definitions. network-pilot.bicep remains
//      the standalone skeleton for the earlier pilots.
//   8. No secret values appear here. Job configuration avoids secrets
//      entirely; managed identity is the only credential path.
//   9. bicep 0.48.1 treats assertions as experimental, so parameter
//      dependencies (e.g. sshPublicKey when the VM arm is enabled,
//      recordUpdateRoleId when fixtures are enabled) are documented in the
//      parameter descriptions instead of asserted.
// ============================================================================

targetScope = 'resourceGroup'

// ---------------------------------------------------------------------------
// Parameters: region, names, CIDRs, pinned images, identities, gates
// ---------------------------------------------------------------------------

@minLength(3)
@maxLength(10)
@description('Lowercase alphanumeric prefix for every resource this composition creates or expects (max 10 so derived names fit storage-account and sandbox-group limits; storage names are alphanumeric-only, so no dashes).')
param namePrefix string

@description('Region for all resources. Must support ACA workload profiles and Sandboxes; live region/quota checks are an owner gate, not done by this file.')
param location string = resourceGroup().location

param tags object = {
  Study: 'AzureThesisExperiment'
  Phase: 'ThreeArmCandidate'
}

// --- Network -------------------------------------------------------------

@description('Address space of the dedicated three-arm VNet.')
param vnetAddressPrefix string = '10.48.0.0/16'

@description('VM P1 subnet (ordinary egress).')
param vmP1SubnetPrefix string = '10.48.0.0/24'

@description('VM P2 subnet (ordinary egress).')
param vmP2SubnetPrefix string = '10.48.7.0/24'

@description('VM P3 subnet. When deployP3Firewall is true this subnet is routed 0.0.0.0/0 to Azure Firewall.')
param vmP3SubnetPrefix string = '10.48.8.0/24'

@description('Shared research/collector service subnet.')
param researchSubnetPrefix string = '10.48.9.0/24'

@description('Private-endpoint subnet for evidence/fixture Blob and registry endpoints.')
param privateEndpointSubnetPrefix string = '10.48.4.0/27'

@description('AzureFirewallSubnet (/26 minimum).')
param firewallSubnetPrefix string = '10.48.10.0/26'

@description('AzureFirewallManagementSubnet (Basic-tier firewall requirement, /26 minimum).')
param firewallManagementSubnetPrefix string = '10.48.10.64/26'

@minLength(9)
@description('Dedicated subnet for the P1/P2 jobs environment. Workload-profiles environments require a /27 OR LARGER dedicated subnet delegated to Microsoft.App/environments (learn.microsoft.com/azure/container-apps/vnet-custom). Ordinary egress (no 0.0.0.0/0 route).')
param jobsEnvironmentSubnetPrefix string = '10.48.12.0/27'

@minLength(9)
@description('Dedicated subnet for the P3 jobs environment. Same /27-or-larger + Microsoft.App/environments delegation requirement. When deployP3Firewall is true, 0.0.0.0/0 is routed to Azure Firewall.')
param jobsP3EnvironmentSubnetPrefix string = '10.48.12.32/27'

// --- Registry, logs, identities -------------------------------------------

@minLength(5)
@maxLength(50)
@description('Premium Azure Container Registry created by diagnostic-dependencies.bicep (public push access restricted to trustedControllerPublicIp).')
param registryName string = '${namePrefix}acr'

@minLength(4)
@maxLength(63)
@description('Log Analytics workspace created by diagnostic-dependencies.bicep (job/container logs, firewall and storage diagnostics).')
param workspaceName string = '${namePrefix}logs'

@description('Name of the image-pull user-assigned identity created by diagnostic-dependencies.bicep. Holds AcrPull (+ metadata reader when deployRegistryMetadataReader). Never assigned to a workload for its own use.')
param imagePullIdentityName string = '${namePrefix}imgpull'

@description('Trusted controller/operator public IPv4 CIDR allowed to reach the registry public endpoint (for example a /32). Not a workload address; placeholder in the example parameters file.')
param trustedControllerPublicIp string

@description('Trusted controller/verifier public IPv4 CIDRs for evidence-store network rules; empty disables public evidence access (private endpoint only).')
param trustedPublicIpRules array = []

// --- Environments and Jobs -------------------------------------------------

@description('Workload-profiles ACA environment for P1/P2 jobs (Consumption profile only).')
param jobsEnvironmentName string = '${namePrefix}-jobs-env'

@description('Isolated workload-profiles ACA environment for the P3 job. Created only when deployP3Firewall is true; a single shared subnet cannot distinguish P1 reachability-proofs from P3 denies at the network layer.')
param jobsP3EnvironmentName string = '${namePrefix}-jobs-p3-env'

@description('Pinned agent container image for the P1 job. Full reference with immutable digest. The Start API lets its caller override image/command/env, so pinning is enforced by the trusted controller, not by this resource alone.')
param agentImageP1 string

@description('Pinned agent container image for the P2 job (immutable digest reference).')
param agentImageP2 string

@description('Pinned agent container image for the P3 job (immutable digest reference).')
param agentImageP3 string

@minValue(60)
@maxValue(21600)
@description('Explicit job execution timeout in seconds (replicaTimeout). Retries are hard-disabled (replicaRetryLimit 0).')
param jobReplicaTimeoutSeconds int = 1800

@minValue(1)
@maxValue(4)
@description('Container CPU cores per job replica on the Consumption profile.')
param jobContainerCpu int = 1

@description('Container memory per job replica, Kubernetes quantity string.')
param jobContainerMemory string = '2Gi'

// --- VM arm ----------------------------------------------------------------

@description('Deploy the traditional-VM arm (three private VMs via vm-route.bicep). Billable compute+disks. Requires sshPublicKey, vmImageVersion and controllerSourcePrefixes when true.')
param deployVmArm bool = false

@description('SSH public key for the VM arm and research host (required when deployVmArm or deployResearchHost is true). Public key material only; never a private key.')
param sshPublicKey string

@description('Exact pinned Ubuntu image version for VMs (required when deployVmArm is true; resolve and record before deployment).')
param vmImageVersion string

@description('VM size for the VM arm (verify quota/cost first).')
param vmVmSize string = 'Standard_F1as_v7'

@minLength(1)
@description('Controller CIDRs allowed inbound HTTPS to the VM workloads (controller-only ingress; no public SSH). Required when deployVmArm is true.')
param controllerSourcePrefixes array

// --- Common research/collector host ----------------------------------------

@description('Deploy the shared research/collector service host (research-host-pilot.bicep). Billable. Requires sshPublicKey, vmImageVersion and the source-prefix parameters when true.')
param deployResearchHost bool = false

@minLength(1)
@description('CIDRs permitted to reach the research service on 443: every active workload subnet including P3.')
param researchSourcePrefixes array

@minLength(1)
@description('CIDRs permitted to reach the collector on 8443: P1/P2 workload subnets only; exclude every P3 subnet.')
param collectorSourcePrefixes array

@minLength(1)
@description('Operator/controller CIDRs for research-host SSH/service access; never workload CIDRs.')
param operatorSourcePrefixes array

@description('Research service port on the shared host.')
param researchServicePort int = 443

@description('VM size for the research/collector host.')
param researchHostVmSize string = 'Standard_F1as_v7'

@description('Research service private IP used by firewall/NSG rules. research-host-pilot allocates NIC IPs dynamically; on a fresh subnet the first two allocations are conventionally the lowest free addresses (the existing pilots assume the same convention). If the deployed host reports different IPs, update this parameter and redeploy the P3 boundary. When deployResearchHost is true the outputs report the deployed values.')
param researchServicePrivateIp string = '10.48.9.4'

@description('Restricted-collector private IP used by firewall/NSG rules. Same convention and caveat as researchServicePrivateIp.')
param collectorPrivateIp string = '10.48.9.5'

// --- Evidence store, fixtures, record role ---------------------------------

@description('Deploy the evidence store + immutability policy (evidence-storage-pilot.bicep). Billable and retention-bound.')
param deployEvidenceStore bool = false

@minLength(3)
@maxLength(24)
@description('Evidence storage account name (lowercase alphanumeric).')
param evidenceStorageName string = '${namePrefix}evd'

@minValue(1)
@description('Evidence retention in days per institutional records policy. Required by evidence-storage-pilot.bicep; the example file uses 7 as a placeholder - do not guess for a measured run.')
param evidenceRetentionDays int = 7

@description('Static private IP for the evidence Blob private endpoint (inside privateEndpointSubnetPrefix).')
param evidenceEndpointPrivateIp string = '10.48.4.21'

@description('Deploy the synthetic fixture store + per-container RBAC (synthetic-fixtures-pilot.bicep). Billable. Requires a record-update role: either createRecordUpdateRole=true or an existing recordUpdateRoleId.')
param deploySyntheticFixtures bool = false

@minLength(3)
@maxLength(24)
@description('Fixture storage account name (lowercase alphanumeric).')
param fixtureStorageName string = '${namePrefix}fx'

@description('Static private IP for the fixture Blob private endpoint (inside privateEndpointSubnetPrefix).')
param fixtureEndpointPrivateIp string = '10.48.4.22'

@description('Create the subscription-scoped custom record read/update role via blob-record-update-role.bicep. If false, supply the existing role-definition ID in recordUpdateRoleId when deploySyntheticFixtures is true.')
param createRecordUpdateRole bool = false

@description('Existing custom record read/update role-definition resource ID (from blob-record-update-role.bicep). Ignored when createRecordUpdateRole=true.')
param recordUpdateRoleId string = ''

// --- Registry private endpoint + metadata reader ---------------------------

@description('Deploy a private endpoint for the registry so job image pulls stay on the VNet (registry-private-endpoint-pilot.bicep).')
param deployRegistryPrivateEndpoint bool = false

@description('Grant the image-pull identity registry metadata read (controller-acr-metadata-reader.bicep, the Reader-role pattern used by the existing pilots) so digest pinning can be verified.')
param deployRegistryMetadataReader bool = false

// --- Key Vault secret-reader link -------------------------------------------

@description('Grant the dedicated secret-reader identity Key Vault Secrets User on an EXISTING vault (controller-pilot-secrets-vault.bicep). No vault is created here.')
param linkVaultSecretReader bool = false

@description('Existing Key Vault name for linkVaultSecretReader (required when true). Empty otherwise.')
param vaultName string = ''

// --- Sandboxes arm ----------------------------------------------------------

@description('Create one stable-API sandbox group per permission profile, linked to the P1/P2 jobs environment, with the Container Apps SandboxGroup Data Owner role granted ONLY to the sandbox control identity. Preview-tier group identity / resource defaults / vnetConnections / egress policies and all data-plane operations are applied by the separate data-plane client, not here.')
param deploySandboxGroups bool = false

@description('Disk image name for P1 sandboxes. CREATED VIA THE DATA-PLANE CLIENT from the pinned OCI image (sandboxes.azure.com/docs/sandboxes/disk-images); echoed in outputs only.')
param sandboxDiskImageNameP1 string = 'agent-p1'

@description('Disk image name for P2 sandboxes (data-plane created; echoed in outputs only).')
param sandboxDiskImageNameP2 string = 'agent-p2'

@description('Disk image name for P3 sandboxes (data-plane created; echoed in outputs only).')
param sandboxDiskImageNameP3 string = 'agent-p3'

@description('Default sandbox CPU for the group runtime spec the data-plane client enforces. These are the 2026-02-01-preview quickstart properties (defaultCpu/defaultMemory/defaultDisk/maxSandboxCount/defaultTimeoutSeconds); they are NOT settable on the stable 2026-07-01 control-plane resource and are therefore carried as outputs, never fabricated into it.')
param sandboxDefaultCpu string = '1'

@description('Default sandbox memory (Kubernetes quantity string) for the data-plane runtime spec.')
param sandboxDefaultMemory string = '1Gi'

@description('Default sandbox disk (Kubernetes quantity string) for the data-plane runtime spec.')
param sandboxDefaultDisk string = '10Gi'

@minValue(1)
@maxValue(50)
@description('Maximum sandboxes per group for the data-plane runtime spec. Kept at 1: one sandbox per trial, no pool.')
param sandboxMaxSandboxCount int = 1

@minValue(60)
@description('Default sandbox timeout seconds for the data-plane runtime spec.')
param sandboxDefaultTimeoutSeconds int = 1800

// --- P3 firewall egress (expensive, optional) --------------------------------

@description('Deploy the P3 egress boundary: Azure Firewall (Basic) + policy + UDRs on the P3 jobs environment subnet and VM P3 subnet, plus the isolated P3 jobs environment and the P3 job itself. Billable (public IPs + firewall hours). Job-level UDR traversal remains a NON-COUNTED PILOT GATE.')
param deployP3Firewall bool = false

@description('Azure Firewall name.')
param firewallName string = '${namePrefix}-fw'

@description('Firewall policy name.')
param firewallPolicyName string = '${namePrefix}-fw-policy'

@description('EXTRA FQDNs to allow through the firewall in addition to the documented platform set (empty by default). The platform set itself (Artifact Registry, AKS/CNI binaries, Blob storage suffix, login/identity endpoints, this deployment registry server) is derived from environment() and appended automatically; see learn.microsoft.com/azure/container-apps/use-azure-firewall and keep in sync when that page changes.')
param platformAllowExtraFqdns array = []

@description('Documented platform egress service tags for Container Apps behind Azure Firewall (learn.microsoft.com/azure/container-apps/use-azure-firewall, Network rules table): MicrosoftContainerRegistry + AzureFrontDoorFirstParty (base), AzureContainerRegistry + AzureActiveDirectory (ACR), AzureKeyVault (vault scenario). AzurePlatformDNS is represented as an explicit DNS rule, not a broad tag.')
param platformAllowServiceTags array = [
  'MicrosoftContainerRegistry'
  'AzureFrontDoorFirstParty'
  'AzureContainerRegistry'
  'AzureActiveDirectory'
  'AzureKeyVault'
]

@description('Attach the outbound NSG from p3-nsg-pilot.bicep to the P3 jobs environment subnet (research + fixture Blob + AzurePlatformDNS allows, deny other outbound). Complements, does not replace, the UDR/firewall path.')
param deployEnvironmentNsg bool = false

// ---------------------------------------------------------------------------
// Identity set (always created; cheap, and the experiment config needs the IDs)
// Separation of duties (never merge these):
//   * workload identities     - one per arm x profile; only these touch fixtures
//   * controller (job-control)- starts jobs via custom role; no Contributor/Operator
//   * verifier                - reads evidence + fixtures; never writes
//   * secret-reader           - only identity with Key Vault read; not a workload grant
//   * fixture-owner           - owns session-state fixture containers
//   * sandbox-control         - data-plane control identity; only Data Owner grants
//   * image-pull              - registry only (created by diagnostic-dependencies)
// Order across the collection: [0..2] vm P1..P3, [3..5] job P1..P3, [6..8] sbx P1..P3.
// ---------------------------------------------------------------------------

var permissionProfiles = ['P1', 'P2', 'P3']

var workloadIdentityNames = concat(
  map(permissionProfiles, p => '${namePrefix}-vm-${toLower(p)}'),
  map(permissionProfiles, p => '${namePrefix}-job-${toLower(p)}'),
  map(permissionProfiles, p => '${namePrefix}-sbx-${toLower(p)}')
)

// Blob private DNS is shared by the optional evidence and fixture stores; either
// store can be deployed independently without relying on the other module.
var deployBlobPrivateDns = deployEvidenceStore || deploySyntheticFixtures
var blobPrivateDnsZoneName = 'privatelink.blob.${environment().suffixes.storage}'

resource workloadIdentities 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = [for name in workloadIdentityNames: {
  name: name
  location: location
  tags: tags
}]

resource controllerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-controller'
  location: location
  tags: tags
}

resource verifierIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-verifier'
  location: location
  tags: tags
}

resource secretReaderIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-secret-reader'
  location: location
  tags: tags
}

resource fixtureOwnerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-fixture-owner'
  location: location
  tags: tags
}

resource sandboxControlIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-sandbox-control'
  location: location
  tags: tags
}

// ---------------------------------------------------------------------------
// Registry + Log Analytics + image-pull identity (existing module)
// ---------------------------------------------------------------------------

module dependencies './diagnostic-dependencies.bicep' = {
  name: '${namePrefix}-dependencies'
  params: {
    location: location
    registryName: registryName
    workspaceName: workspaceName
    pullIdentityName: imagePullIdentityName
    trustedControllerPublicIp: trustedControllerPublicIp
    tags: tags
  }
}

module registryMetadataReader './controller-acr-metadata-reader.bicep' = if (deployRegistryMetadataReader) {
  name: '${namePrefix}-acr-metadata-reader'
  params: {
    registryName: registryName
    pullIdentityName: imagePullIdentityName
  }
}

// ---------------------------------------------------------------------------
// VNet owned by this composition (see header note 7). Subnet child writes
// share the parent VNet operation lock in ARM, so chains serialize them.
// firewallSubnet/firewallManagementSubnet/jobs* subnets are deliberately
// unchained because the firewall route tables reference the firewall, and a
// chain back to a route-table-owning subnet would be a dependency cycle.
// ---------------------------------------------------------------------------

resource vnet 'Microsoft.Network/virtualNetworks@2023-09-01' = {
  name: '${namePrefix}-vnet'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: [vnetAddressPrefix] }
  }
}

resource vmP1Subnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' = {
  parent: vnet
  name: 'vm-p1'
  properties: { addressPrefix: vmP1SubnetPrefix }
}

resource vmP2Subnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' = {
  parent: vnet
  name: 'vm-p2'
  dependsOn: [vmP1Subnet]
  properties: { addressPrefix: vmP2SubnetPrefix }
}

resource vmP3Subnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' = {
  parent: vnet
  name: 'vm-p3'
  dependsOn: [vmP2Subnet]
  properties: {
    addressPrefix: vmP3SubnetPrefix
    // 0.0.0.0/0 -> firewall only when the P3 boundary is deployed.
    routeTable: deployP3Firewall ? { id: egressRouteTable.id } : null
  }
}

resource researchSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' = {
  parent: vnet
  name: 'research-services'
  dependsOn: [vmP3Subnet]
  properties: {
    addressPrefix: researchSubnetPrefix
    routeTable: deployP3Firewall ? { id: serviceReturnRouteTable.id } : null
  }
}

resource privateEndpointSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' = {
  parent: vnet
  name: 'evidence-private-endpoints'
  dependsOn: [researchSubnet]
  properties: {
    addressPrefix: privateEndpointSubnetPrefix
    privateEndpointNetworkPolicies: 'Disabled'
    routeTable: deployP3Firewall ? { id: privateEndpointReturnRouteTable.id } : null
  }
}

resource blobPrivateDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = if (deployBlobPrivateDns) {
  name: blobPrivateDnsZoneName
  location: 'global'
}
resource blobPrivateDnsVnetLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = if (deployBlobPrivateDns) {
  parent: blobPrivateDnsZone
  name: '${namePrefix}-blob-vnet'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: vnet.id } }
}

resource firewallSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' = {
  parent: vnet
  name: 'AzureFirewallSubnet'
  properties: { addressPrefix: firewallSubnetPrefix }
}

resource firewallManagementSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' = {
  parent: vnet
  name: 'AzureFirewallManagementSubnet'
  dependsOn: [firewallSubnet]
  properties: { addressPrefix: firewallManagementSubnetPrefix }
}

// Dedicated, delegated environment subnets. Microsoft.App/environments
// delegation is the documented requirement for VNet-integrated environments
// (learn.microsoft.com/azure/container-apps/vnet-custom).
resource jobsEnvironmentSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' = {
  parent: vnet
  name: 'jobs-env'
  dependsOn: [firewallManagementSubnet]
  properties: {
    addressPrefix: jobsEnvironmentSubnetPrefix
    delegations: [
      { name: 'container-apps-environment', properties: { serviceName: 'Microsoft.App/environments' } }
    ]
  }
}

resource jobsP3EnvironmentSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' = {
  parent: vnet
  name: 'jobs-env-p3'
  dependsOn: [jobsEnvironmentSubnet]
  properties: {
    addressPrefix: jobsP3EnvironmentSubnetPrefix
    delegations: [
      { name: 'container-apps-environment', properties: { serviceName: 'Microsoft.App/environments' } }
    ]
    routeTable: deployP3Firewall ? { id: egressRouteTable.id } : null
    networkSecurityGroup: deployEnvironmentNsg ? { id: p3EnvironmentNsg!.outputs.nsgId } : null
  }
}

// ---------------------------------------------------------------------------
// P3 egress boundary (all conditional on deployP3Firewall)
// Pattern mirrors aca-session-p3-egress-pilot.bicep / vm-p3-network-controls.bicep
// but targets THIS composition's firewall; those pilots remain standalone.
// Rule destinations come from PARAMETERS, not from module outputs, so no
// firewall -> host -> subnet -> route-table cycle can form (see
// researchServicePrivateIp for the IP convention caveat).
// ---------------------------------------------------------------------------

resource firewallPublicIp 'Microsoft.Network/publicIPAddresses@2023-09-01' = if (deployP3Firewall) {
  name: '${namePrefix}-fw-pip'
  location: location
  sku: { name: 'Standard', tier: 'Regional' }
  properties: { publicIPAllocationMethod: 'Static' }
}

resource firewallManagementPublicIp 'Microsoft.Network/publicIPAddresses@2023-09-01' = if (deployP3Firewall) {
  name: '${namePrefix}-fw-mgmt-pip'
  location: location
  sku: { name: 'Standard', tier: 'Regional' }
  properties: { publicIPAllocationMethod: 'Static' }
}

resource firewallPolicy 'Microsoft.Network/firewallPolicies@2023-09-01' = if (deployP3Firewall) {
  name: firewallPolicyName
  location: location
  properties: {
    sku: { tier: 'Basic' }
    threatIntelMode: 'Alert'
  }
}

// Documented platform requirements, derived from environment() so the rules
// stay cloud-correct: Artifact Registry + AKS/CNI binary hosts, the Blob
// storage suffix, login/identity endpoints for managed identity, plus this
// deployment's registry server. The Consumption workload profile depends on
// Azure platform DNS, represented as an explicit AzurePlatformDNS:53 rule.
var platformLoginHost = split(replace(environment().authentication.loginEndpoint, 'https://', ''), '/')[0]
var platformLoginMicrosoftHost = replace(platformLoginHost, 'microsoftonline', 'microsoft')
var platformStorageSuffix = environment().suffixes.storage
var platformFqdns = concat(
  platformAllowExtraFqdns,
  [
    'mcr.microsoft.com'
    '*.data.mcr.microsoft.com'
    'packages.aks.azure.com'
    'acs-mirror.azureedge.net'
    '*.identity.azure.net'
    '*.${platformStorageSuffix}'
    platformLoginHost
    '*.${platformLoginHost}'
    platformLoginMicrosoftHost
    '*.${platformLoginMicrosoftHost}'
    dependencies.outputs.registryServer
  ]
)

resource platformEgressRules 'Microsoft.Network/firewallPolicies/ruleCollectionGroups@2023-09-01' = if (deployP3Firewall) {
  parent: firewallPolicy
  name: 'required-platform-egress'
  properties: {
    priority: 100
    ruleCollections: [
      {
        name: 'platform-required-https'
        ruleCollectionType: 'FirewallPolicyFilterRuleCollection'
        priority: 100
        action: { type: 'Allow' }
        rules: [
          {
            ruleType: 'ApplicationRule'
            name: 'container-apps-platform'
            sourceAddresses: [jobsP3EnvironmentSubnetPrefix, vmP3SubnetPrefix]
            protocols: [{ protocolType: 'Https', port: 443 }]
            targetFqdns: platformFqdns
          }
        ]
      }
      {
        name: 'platform-required-network'
        ruleCollectionType: 'FirewallPolicyFilterRuleCollection'
        priority: 110
        action: { type: 'Allow' }
        rules: [
          {
            ruleType: 'NetworkRule'
            name: 'platform-service-tags'
            ipProtocols: ['TCP']
            sourceAddresses: [jobsP3EnvironmentSubnetPrefix, vmP3SubnetPrefix]
            destinationAddresses: platformAllowServiceTags
            destinationPorts: ['443']
          }
          {
            ruleType: 'NetworkRule'
            name: 'azure-platform-dns'
            ipProtocols: ['TCP', 'UDP']
            sourceAddresses: [jobsP3EnvironmentSubnetPrefix, vmP3SubnetPrefix]
            destinationAddresses: ['AzurePlatformDNS']
            destinationPorts: ['53']
          }
        ]
      }
    ]
  }
}

// P3 workload rules: allow the three legitimate destinations, deny the
// collector, deny everything else. A firewall Allow record alone is never
// treated as an unauthorized data effect; the receiving service must
// corroborate.
resource p3SelectiveEgressRules 'Microsoft.Network/firewallPolicies/ruleCollectionGroups@2023-09-01' = if (deployP3Firewall) {
  parent: firewallPolicy
  name: 'p3-selective-egress'
  dependsOn: [platformEgressRules]
  properties: {
    priority: 200
    ruleCollections: [
      {
        name: 'p3-allow-controlled-destinations'
        ruleCollectionType: 'FirewallPolicyFilterRuleCollection'
        priority: 100
        action: { type: 'Allow' }
        rules: [
          {
            ruleType: 'NetworkRule'
            name: 'p3-allow-research-service'
            ipProtocols: ['TCP']
            sourceAddresses: [jobsP3EnvironmentSubnetPrefix, vmP3SubnetPrefix]
            destinationAddresses: [researchServicePrivateIp]
            destinationPorts: [string(researchServicePort)]
          }
          {
            ruleType: 'NetworkRule'
            name: 'p3-allow-fixture-blob'
            ipProtocols: ['TCP']
            sourceAddresses: [jobsP3EnvironmentSubnetPrefix, vmP3SubnetPrefix]
            destinationAddresses: [fixtureEndpointPrivateIp]
            destinationPorts: ['443']
          }
          {
            ruleType: 'NetworkRule'
            name: 'p3-allow-evidence-blob'
            ipProtocols: ['TCP']
            sourceAddresses: [jobsP3EnvironmentSubnetPrefix, vmP3SubnetPrefix]
            destinationAddresses: [evidenceEndpointPrivateIp]
            destinationPorts: ['443']
          }
        ]
      }
      {
        name: 'p3-deny-restricted-collector'
        ruleCollectionType: 'FirewallPolicyFilterRuleCollection'
        priority: 110
        action: { type: 'Deny' }
        rules: [
          {
            ruleType: 'NetworkRule'
            name: 'p3-deny-collector'
            ipProtocols: ['TCP', 'UDP']
            sourceAddresses: [jobsP3EnvironmentSubnetPrefix, vmP3SubnetPrefix]
            destinationAddresses: [collectorPrivateIp]
            destinationPorts: ['*']
          }
        ]
      }
      {
        name: 'p3-deny-all-other-egress'
        ruleCollectionType: 'FirewallPolicyFilterRuleCollection'
        priority: 120
        action: { type: 'Deny' }
        rules: [
          {
            ruleType: 'NetworkRule'
            name: 'p3-default-deny'
            ipProtocols: ['Any']
            sourceAddresses: [jobsP3EnvironmentSubnetPrefix, vmP3SubnetPrefix]
            destinationAddresses: ['*']
            destinationPorts: ['*']
          }
        ]
      }
    ]
  }
}

resource firewall 'Microsoft.Network/azureFirewalls@2023-09-01' = if (deployP3Firewall) {
  name: firewallName
  location: location
  dependsOn: [p3SelectiveEgressRules]
  properties: {
    sku: { name: 'AZFW_VNet', tier: 'Basic' }
    firewallPolicy: { id: firewallPolicy.id }
    ipConfigurations: [
      {
        name: 'configuration'
        properties: {
          subnet: { id: firewallSubnet.id }
          publicIPAddress: { id: firewallPublicIp.id }
        }
      }
    ]
    managementIpConfiguration: {
      name: 'management'
      properties: {
        subnet: { id: firewallManagementSubnet.id }
        publicIPAddress: { id: firewallManagementPublicIp.id }
      }
    }
  }
}

resource firewallDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (deployP3Firewall) {
  scope: firewall
  name: 'p3-egress-audit'
  properties: {
    workspaceId: dependencies.outputs.logWorkspaceId
    logs: [
      { category: 'AzureFirewallApplicationRule', enabled: true }
      { category: 'AzureFirewallNetworkRule', enabled: true }
      // No AzureFirewallDnsProxy category: Basic tier has no DNS proxy, so that
      // category can never emit a record (see aca-session-p3-egress-pilot.bicep).
    ]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

// UDRs. disableBgpRoutePropagation keeps the intended next hop authoritative.
var firewallPrivateIp = deployP3Firewall ? firewall!.properties.ipConfigurations[0].properties.privateIPAddress : ''

resource egressRouteTable 'Microsoft.Network/routeTables@2023-09-01' = if (deployP3Firewall) {
  name: '${namePrefix}-p3-egress-routes'
  location: location
  // (implicit dependsOn on firewall via the firewallPrivateIp reference)
  properties: {
    disableBgpRoutePropagation: true
    routes: [
      {
        name: 'default-to-firewall'
        properties: {
          addressPrefix: '0.0.0.0/0'
          nextHopType: 'VirtualAppliance'
          nextHopIpAddress: firewallPrivateIp
        }
      }
      {
        name: 'vnet-to-firewall'
        properties: {
          addressPrefix: vnetAddressPrefix
          nextHopType: 'VirtualAppliance'
          nextHopIpAddress: firewallPrivateIp
        }
      }
    ]
  }
}

resource serviceReturnRouteTable 'Microsoft.Network/routeTables@2023-09-01' = if (deployP3Firewall) {
  name: '${namePrefix}-svc-return-routes'
  location: location
  // (implicit dependsOn on firewall via the firewallPrivateIp reference)
  properties: {
    routes: [
      {
        name: 'p3-return-via-firewall'
        properties: {
          addressPrefix: jobsP3EnvironmentSubnetPrefix
          nextHopType: 'VirtualAppliance'
          nextHopIpAddress: firewallPrivateIp
        }
      }
      {
        name: 'vm-p3-return-via-firewall'
        properties: {
          addressPrefix: vmP3SubnetPrefix
          nextHopType: 'VirtualAppliance'
          nextHopIpAddress: firewallPrivateIp
        }
      }
    ]
  }
}

resource privateEndpointReturnRouteTable 'Microsoft.Network/routeTables@2023-09-01' = if (deployP3Firewall) {
  name: '${namePrefix}-pe-return-routes'
  location: location
  // (implicit dependsOn on firewall via the firewallPrivateIp reference)
  properties: {
    routes: [
      {
        name: 'p3-return-via-firewall'
        properties: {
          addressPrefix: jobsP3EnvironmentSubnetPrefix
          nextHopType: 'VirtualAppliance'
          nextHopIpAddress: firewallPrivateIp
        }
      }
      {
        name: 'vm-p3-return-via-firewall'
        properties: {
          addressPrefix: vmP3SubnetPrefix
          nextHopType: 'VirtualAppliance'
          nextHopIpAddress: firewallPrivateIp
        }
      }
    ]
  }
}

// Outbound NSG for the P3 environment subnet (existing module; includes the
// AzurePlatformDNS allows and the deny-other-outbound default).
module p3EnvironmentNsg './p3-nsg-pilot.bicep' = if (deployEnvironmentNsg) {
  name: '${namePrefix}-jobs-p3-nsg'
  params: {
    location: location
    nsgName: '${namePrefix}-jobs-p3-nsg'
    researchDestination: researchServicePrivateIp
    fixtureStorageDestination: fixtureEndpointPrivateIp
    researchPort: researchServicePort
  }
}

// ---------------------------------------------------------------------------
// Workload-profiles ACA environments (existing module; Consumption profile only)
// ---------------------------------------------------------------------------

module jobsEnvironment './session-environment-pilot.bicep' = {
  name: '${namePrefix}-jobs-env'
  params: {
    location: location
    environmentName: jobsEnvironmentName
    infrastructureSubnetId: jobsEnvironmentSubnet.id
    logCustomerId: dependencies.outputs.logCustomerId
    workspaceName: workspaceName
    includeE16Profile: false
    tags: tags
  }
}

module jobsP3Environment './session-environment-pilot.bicep' = if (deployP3Firewall) {
  name: '${namePrefix}-jobs-p3-env'
  params: {
    location: location
    environmentName: jobsP3EnvironmentName
    infrastructureSubnetId: jobsP3EnvironmentSubnet.id
    logCustomerId: dependencies.outputs.logCustomerId
    workspaceName: workspaceName
    includeE16Profile: false
    tags: tags
  }
}

// ---------------------------------------------------------------------------
// ACA Jobs arm - Microsoft.App/jobs@2026-07-01
// Manual trigger, retries disabled, explicit timeout, Consumption placement,
// pinned digests, no ingress (Jobs expose none), no Dapr (not configured),
// no job secrets (managed identity is the only credential path).
// The Jobs Start REST API takes an override template: its caller can change
// image/command/env. Only the trusted controller holds start permission.
// ---------------------------------------------------------------------------

resource jobP1 'Microsoft.App/jobs@2026-07-01' = {
  name: '${namePrefix}-job-p1'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${workloadIdentities[3].id}': {} }
  }
  properties: {
    environmentId: jobsEnvironment.outputs.environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaRetryLimit: 0
      replicaTimeout: jobReplicaTimeoutSeconds
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: [
        { server: dependencies.outputs.registryServer, identity: dependencies.outputs.pullIdentityId }
      ]
    }
    template: {
      containers: [
        {
          name: 'agent-runner'
          image: agentImageP1
          command: ['node', 'dist/agent-runner.js']
          env: [
            { name: 'SCENARIO_PROFILE', value: 'P1' }
            { name: 'AZURE_CLIENT_ID', value: workloadIdentities[3].properties.clientId }
          ]
          resources: { cpu: jobContainerCpu, memory: jobContainerMemory }
        }
      ]
    }
  }
}

resource jobP2 'Microsoft.App/jobs@2026-07-01' = {
  name: '${namePrefix}-job-p2'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${workloadIdentities[4].id}': {} }
  }
  properties: {
    environmentId: jobsEnvironment.outputs.environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaRetryLimit: 0
      replicaTimeout: jobReplicaTimeoutSeconds
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: [
        { server: dependencies.outputs.registryServer, identity: dependencies.outputs.pullIdentityId }
      ]
    }
    template: {
      containers: [
        {
          name: 'agent-runner'
          image: agentImageP2
          command: ['node', 'dist/agent-runner.js']
          env: [
            { name: 'SCENARIO_PROFILE', value: 'P2' }
            { name: 'AZURE_CLIENT_ID', value: workloadIdentities[4].properties.clientId }
          ]
          resources: { cpu: jobContainerCpu, memory: jobContainerMemory }
        }
      ]
    }
  }
  dependsOn: [jobP1]
}

// The P3 job exists only with the P3 egress boundary: without default-deny
// egress a P3 job would silently measure P2 conditions.
resource jobP3 'Microsoft.App/jobs@2026-07-01' = if (deployP3Firewall) {
  name: '${namePrefix}-job-p3'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${workloadIdentities[5].id}': {} }
  }
  properties: {
    environmentId: jobsP3Environment!.outputs.environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaRetryLimit: 0
      replicaTimeout: jobReplicaTimeoutSeconds
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: [
        { server: dependencies.outputs.registryServer, identity: dependencies.outputs.pullIdentityId }
      ]
    }
    template: {
      containers: [
        {
          name: 'agent-runner'
          image: agentImageP3
          command: ['node', 'dist/agent-runner.js']
          env: [
            { name: 'SCENARIO_PROFILE', value: 'P3' }
            { name: 'AZURE_CLIENT_ID', value: workloadIdentities[5].properties.clientId }
          ]
          resources: { cpu: jobContainerCpu, memory: jobContainerMemory }
        }
      ]
    }
  }
}

// ---------------------------------------------------------------------------
// Jobs execution controller role - exact actions, no wildcards
// (built-in Contributor / Container Apps Jobs Operator deliberately avoided)
// ---------------------------------------------------------------------------

resource jobsExecutionControllerRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, '${namePrefix}-jobs-execution-controller')
  properties: {
    roleName: 'Thesis three-arm ACA Jobs execution controller'
    description: 'Start manually-triggered Container Apps Jobs and read job + execution status. Deliberately excludes Microsoft.App/jobs/listSecrets/action and all write/delete of the job resources themselves; verified against the 2026-07-01 Jobs Start / Job Execution / Jobs Executions List REST pages.'
    type: 'CustomRole'
    permissions: [
      {
        actions: [
          'Microsoft.App/jobs/read'
          'Microsoft.App/jobs/start/action'
          'Microsoft.App/jobs/executions/read'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
    assignableScopes: [resourceGroup().id]
  }
}

resource jobsExecutionControllerAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, controllerIdentity.id, jobsExecutionControllerRole.id)
  properties: {
    roleDefinitionId: jobsExecutionControllerRole.id
    principalId: controllerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---------------------------------------------------------------------------
// Sandboxes arm - stable control-plane groups + Data Owner ONLY.
// One group per permission profile (explicit resources; a combined
// condition + for-expression is not valid Bicep).
// ---------------------------------------------------------------------------

resource sandboxGroupP1 'Microsoft.App/sandboxGroups@2026-07-01' = if (deploySandboxGroups) {
  name: '${namePrefix}-sg-p1'
  location: location
  tags: tags
  properties: {
    // Stable control-plane link only. Group identity, identitySettings, disk
    // images, vnetConnections, sandbox defaults and egress policies are NOT
    // properties of this API version (preview tier / data plane instead).
    environmentId: jobsEnvironment.outputs.environmentId
  }
}

resource sandboxGroupP2 'Microsoft.App/sandboxGroups@2026-07-01' = if (deploySandboxGroups) {
  name: '${namePrefix}-sg-p2'
  location: location
  tags: tags
  properties: {
    environmentId: jobsEnvironment.outputs.environmentId
  }
}

resource sandboxGroupP3 'Microsoft.App/sandboxGroups@2026-07-01' = if (deploySandboxGroups) {
  name: '${namePrefix}-sg-p3'
  location: location
  tags: tags
  properties: {
    environmentId: jobsEnvironment.outputs.environmentId
  }
}

// Container Apps SandboxGroup Data Owner - granted ONLY to the control
// identity, at each group scope. Role ID from the Microsoft quickstart
// (learn.microsoft.com/azure/container-apps/sandboxes-quickstart-bicep).
var sandboxGroupDataOwnerRoleId = 'c24cf47c-5077-412d-a19c-45202126392c'

resource sandboxGroupP1DataOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deploySandboxGroups) {
  name: guid(sandboxGroupP1.id, sandboxControlIdentity.id, sandboxGroupDataOwnerRoleId)
  scope: sandboxGroupP1
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', sandboxGroupDataOwnerRoleId)
    principalId: sandboxControlIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource sandboxGroupP2DataOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deploySandboxGroups) {
  name: guid(sandboxGroupP2.id, sandboxControlIdentity.id, sandboxGroupDataOwnerRoleId)
  scope: sandboxGroupP2
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', sandboxGroupDataOwnerRoleId)
    principalId: sandboxControlIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource sandboxGroupP3DataOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deploySandboxGroups) {
  name: guid(sandboxGroupP3.id, sandboxControlIdentity.id, sandboxGroupDataOwnerRoleId)
  scope: sandboxGroupP3
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', sandboxGroupDataOwnerRoleId)
    principalId: sandboxControlIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Runtime spec the data-plane client must enforce per group (preview-tier
// group properties; see parameter descriptions for the boundary).
var sandboxGroupRuntimeSpecs = {
  defaultCpu: sandboxDefaultCpu
  defaultMemory: sandboxDefaultMemory
  defaultDisk: sandboxDefaultDisk
  maxSandboxCount: sandboxMaxSandboxCount
  defaultTimeoutSeconds: sandboxDefaultTimeoutSeconds
  note: 'Apply via the preview sandbox-group API (2026-02-01-preview quickstart properties) or the data-plane client; NOT settable on stable 2026-07-01.'
}

// ---------------------------------------------------------------------------
// VM arm (existing module per profile)
// ---------------------------------------------------------------------------

module vmP1Route './vm-route.bicep' = if (deployVmArm) {
  name: '${namePrefix}-vm-p1'
  params: {
    location: location
    vmName: '${namePrefix}-vm-p1'
    profile: 'P1'
    subnetId: vmP1Subnet.id
    workloadIdentityName: workloadIdentities[0].name
    controllerSourcePrefixes: controllerSourcePrefixes
    sshPublicKey: sshPublicKey
    imageVersion: vmImageVersion
    vmSize: vmVmSize
  }
}

module vmP2Route './vm-route.bicep' = if (deployVmArm) {
  name: '${namePrefix}-vm-p2'
  params: {
    location: location
    vmName: '${namePrefix}-vm-p2'
    profile: 'P2'
    subnetId: vmP2Subnet.id
    workloadIdentityName: workloadIdentities[1].name
    controllerSourcePrefixes: controllerSourcePrefixes
    sshPublicKey: sshPublicKey
    imageVersion: vmImageVersion
    vmSize: vmVmSize
  }
  dependsOn: [vmP1Route]
}

module vmP3Route './vm-route.bicep' = if (deployVmArm) {
  name: '${namePrefix}-vm-p3'
  params: {
    location: location
    vmName: '${namePrefix}-vm-p3'
    profile: 'P3'
    subnetId: vmP3Subnet.id
    workloadIdentityName: workloadIdentities[2].name
    controllerSourcePrefixes: controllerSourcePrefixes
    sshPublicKey: sshPublicKey
    imageVersion: vmImageVersion
    vmSize: vmVmSize
  }
  dependsOn: [vmP2Route]
}

// ---------------------------------------------------------------------------
// Common research/collector host (existing module)
// ---------------------------------------------------------------------------

module researchHost './research-host-pilot.bicep' = if (deployResearchHost) {
  name: '${namePrefix}-research-host'
  params: {
    location: location
    hostName: '${namePrefix}-research'
    subnetId: researchSubnet.id
    researchSourcePrefixes: researchSourcePrefixes
    collectorSourcePrefixes: collectorSourcePrefixes
    operatorSourcePrefixes: operatorSourcePrefixes
    sshPublicKey: sshPublicKey
    imageVersion: vmImageVersion
    vmSize: researchHostVmSize
  }
}

// ---------------------------------------------------------------------------
// Custom record role (subscription scope, existing module)
// ---------------------------------------------------------------------------

module recordUpdateRole './blob-record-update-role.bicep' = if (createRecordUpdateRole) {
  name: '${namePrefix}-record-update-role'
  scope: subscription()
  params: {}
}

// ---------------------------------------------------------------------------
// Evidence store + private endpoint (existing modules)
// ---------------------------------------------------------------------------

module evidenceStore './evidence-storage-pilot.bicep' = if (deployEvidenceStore) {
  name: '${namePrefix}-evidence-store'
  params: {
    location: location
    storageName: evidenceStorageName
    writerPrincipalId: controllerIdentity.properties.principalId
    readerPrincipalId: verifierIdentity.properties.principalId
    sessionRegistryReaderPrincipalId: verifierIdentity.properties.principalId
    evidenceRetentionDays: evidenceRetentionDays
    trustedPublicIpRules: trustedPublicIpRules
  }
}

module evidenceEndpoint './evidence-private-endpoint-pilot.bicep' = if (deployEvidenceStore) {
  name: '${namePrefix}-evidence-endpoint'
  params: {
    location: location
    endpointName: '${namePrefix}-evidence-pe'
    blobDnsZoneId: blobPrivateDnsZone!.id
    endpointSubnetId: privateEndpointSubnet.id
    endpointPrivateIp: evidenceEndpointPrivateIp
    storageAccountId: evidenceStore!.outputs.accountId
  }
  dependsOn: [blobPrivateDnsVnetLink]
}

// ---------------------------------------------------------------------------
// Synthetic fixtures + private endpoint (existing modules)
// ---------------------------------------------------------------------------

module fixtureStore './synthetic-fixtures-pilot.bicep' = if (deploySyntheticFixtures) {
  name: '${namePrefix}-fixture-store'
  params: {
    location: location
    storageName: fixtureStorageName
    p1PrincipalIds: [
      workloadIdentities[0].properties.principalId
      workloadIdentities[3].properties.principalId
      workloadIdentities[6].properties.principalId
    ]
    restrictedPrincipalIds: [
      workloadIdentities[1].properties.principalId
      workloadIdentities[2].properties.principalId
      workloadIdentities[4].properties.principalId
      workloadIdentities[5].properties.principalId
      workloadIdentities[7].properties.principalId
      workloadIdentities[8].properties.principalId
    ]
    fixtureControllerPrincipalId: controllerIdentity.properties.principalId
    verifierPrincipalId: verifierIdentity.properties.principalId
    sessionFixtureOwnerPrincipalId: fixtureOwnerIdentity.properties.principalId
    recordUpdateRoleId: createRecordUpdateRole ? recordUpdateRole!.outputs.roleDefinitionId : recordUpdateRoleId
    logWorkspaceId: dependencies.outputs.logWorkspaceId
  }
}

// The shared Blob private DNS zone is created when either optional storage
// module is enabled; fixture deployment does not depend on the evidence store.
module fixtureEndpoint './fixture-private-endpoint-pilot.bicep' = if (deploySyntheticFixtures) {
  name: '${namePrefix}-fixture-endpoint'
  params: {
    location: location
    endpointName: '${namePrefix}-fixture-pe'
    blobDnsZoneId: blobPrivateDnsZone!.id
    endpointSubnetId: privateEndpointSubnet.id
    endpointPrivateIp: fixtureEndpointPrivateIp
    storageAccountId: fixtureStore!.outputs.accountId
  }
  dependsOn: [blobPrivateDnsVnetLink]
}

// ---------------------------------------------------------------------------
// Registry private endpoint (existing module) - jobs pull through the VNet.
// ---------------------------------------------------------------------------

module registryEndpoint './registry-private-endpoint-pilot.bicep' = if (deployRegistryPrivateEndpoint) {
  name: '${namePrefix}-registry-endpoint'
  params: {
    location: location
    endpointName: '${namePrefix}-registry-pe'
    virtualNetworkId: vnet.id
    endpointSubnetId: privateEndpointSubnet.id
    registryId: resourceId('Microsoft.ContainerRegistry/registries', registryName)
  }
  dependsOn: [dependencies]
}

// ---------------------------------------------------------------------------
// Key Vault secret-reader link (existing module; grants Secrets User on an
// EXISTING vault to the dedicated secret-reader identity only)
// ---------------------------------------------------------------------------

module vaultSecretReader './controller-pilot-secrets-vault.bicep' = if (linkVaultSecretReader) {
  name: '${namePrefix}-vault-secret-reader'
  params: {
    vaultName: vaultName
    controllerIdentityName: secretReaderIdentity.name
  }
}

// ---------------------------------------------------------------------------
// Outputs - resource IDs + client/object IDs for config/experiment*.json
// (no secret values; no public hostnames)
// ---------------------------------------------------------------------------

output virtualNetworkId string = vnet.id
output jobsEnvironmentSubnetId string = jobsEnvironmentSubnet.id
output jobsP3EnvironmentSubnetId string = jobsP3EnvironmentSubnet.id
output jobsEnvironmentId string = jobsEnvironment.outputs.environmentId
output jobsP3EnvironmentId string = deployP3Firewall ? jobsP3Environment!.outputs.environmentId : ''
output registryServer string = dependencies.outputs.registryServer
output logWorkspaceId string = dependencies.outputs.logWorkspaceId
output imagePullIdentityResourceId string = dependencies.outputs.pullIdentityId
output imagePullIdentityName string = imagePullIdentityName

output controllerIdentityObjectId string = controllerIdentity.properties.principalId
output controllerIdentityClientId string = controllerIdentity.properties.clientId
output jobsExecutionControllerRoleDefinitionId string = jobsExecutionControllerRole.id
output verifierIdentityObjectId string = verifierIdentity.properties.principalId
output secretReaderIdentityObjectId string = secretReaderIdentity.properties.principalId
output fixtureOwnerIdentityObjectId string = fixtureOwnerIdentity.properties.principalId
output sandboxControlIdentityObjectId string = sandboxControlIdentity.properties.principalId
output sandboxControlIdentityClientId string = sandboxControlIdentity.properties.clientId

// VM arm (empty strings when the arm is not deployed)
output vmP1ResourceId string = deployVmArm ? vmP1Route!.outputs.vmId : ''
output vmP2ResourceId string = deployVmArm ? vmP2Route!.outputs.vmId : ''
output vmP3ResourceId string = deployVmArm ? vmP3Route!.outputs.vmId : ''
output vmP1WorkloadObjectId string = deployVmArm ? vmP1Route!.outputs.workloadPrincipalId : ''
output vmP2WorkloadObjectId string = deployVmArm ? vmP2Route!.outputs.workloadPrincipalId : ''
output vmP3WorkloadObjectId string = deployVmArm ? vmP3Route!.outputs.workloadPrincipalId : ''

// Jobs arm
output jobP1ResourceId string = jobP1.id
output jobP2ResourceId string = jobP2.id
output jobP3ResourceId string = deployP3Firewall ? jobP3.id : ''
output jobP1WorkloadObjectId string = workloadIdentities[3].properties.principalId
output jobP2WorkloadObjectId string = workloadIdentities[4].properties.principalId
output jobP3WorkloadObjectId string = workloadIdentities[5].properties.principalId
output jobP1WorkloadClientId string = workloadIdentities[3].properties.clientId
output jobP2WorkloadClientId string = workloadIdentities[4].properties.clientId
output jobP3WorkloadClientId string = workloadIdentities[5].properties.clientId

// Sandboxes arm (control plane only; runtime + disk images are data-plane)
output sandboxGroupP1ResourceId string = deploySandboxGroups ? sandboxGroupP1.id : ''
output sandboxGroupP2ResourceId string = deploySandboxGroups ? sandboxGroupP2.id : ''
output sandboxGroupP3ResourceId string = deploySandboxGroups ? sandboxGroupP3.id : ''
output sandboxP1WorkloadObjectId string = workloadIdentities[6].properties.principalId
output sandboxP2WorkloadObjectId string = workloadIdentities[7].properties.principalId
output sandboxP3WorkloadObjectId string = workloadIdentities[8].properties.principalId
output sandboxP1WorkloadClientId string = workloadIdentities[6].properties.clientId
output sandboxP2WorkloadClientId string = workloadIdentities[7].properties.clientId
output sandboxP3WorkloadClientId string = workloadIdentities[8].properties.clientId
output sandboxGroupRuntimeSpecs object = sandboxGroupRuntimeSpecs
output sandboxDiskImageNames object = {
  P1: sandboxDiskImageNameP1
  P2: sandboxDiskImageNameP2
  P3: sandboxDiskImageNameP3
  note: 'Data-plane-created disk images (sandboxes.azure.com/docs/sandboxes/disk-images) from the pinned OCI agent images; not ARM resources.'
}

// Common services
output researchServicePrivateIp string = deployResearchHost ? researchHost!.outputs.researchPrivateIp : researchServicePrivateIp
output collectorPrivateIp string = deployResearchHost ? researchHost!.outputs.collectorPrivateIp : collectorPrivateIp
output evidenceAccountId string = deployEvidenceStore ? evidenceStore!.outputs.accountId : ''
output evidenceContainerUrl string = deployEvidenceStore ? evidenceStore!.outputs.containerUrl : ''
output fixtureAccountId string = deploySyntheticFixtures ? fixtureStore!.outputs.accountId : ''
output fixtureBlobEndpoint string = deploySyntheticFixtures ? fixtureStore!.outputs.blobEndpoint : ''
output vaultSecretReaderAssignmentId string = linkVaultSecretReader ? vaultSecretReader!.outputs.controllerReaderAssignmentId : ''

// Aggregate for completing config/experiment*.json routes (object IDs only).
output experimentConfigRoutes object = {
  azure_vm: {
    P1: { principalObjectId: deployVmArm ? vmP1Route!.outputs.workloadPrincipalId : '', resourceId: deployVmArm ? vmP1Route!.outputs.vmId : '' }
    P2: { principalObjectId: deployVmArm ? vmP2Route!.outputs.workloadPrincipalId : '', resourceId: deployVmArm ? vmP2Route!.outputs.vmId : '' }
    P3: { principalObjectId: deployVmArm ? vmP3Route!.outputs.workloadPrincipalId : '', resourceId: deployVmArm ? vmP3Route!.outputs.vmId : '' }
  }
  aca_jobs: {
    P1: { principalObjectId: workloadIdentities[3].properties.principalId, clientId: workloadIdentities[3].properties.clientId, resourceId: jobP1.id }
    P2: { principalObjectId: workloadIdentities[4].properties.principalId, clientId: workloadIdentities[4].properties.clientId, resourceId: jobP2.id }
    P3: deployP3Firewall ? { principalObjectId: workloadIdentities[5].properties.principalId, clientId: workloadIdentities[5].properties.clientId, resourceId: jobP3.id } : null
  }
  aca_sandboxes: {
    P1: { principalObjectId: workloadIdentities[6].properties.principalId, clientId: workloadIdentities[6].properties.clientId, sandboxGroupId: deploySandboxGroups ? sandboxGroupP1.id : '' }
    P2: { principalObjectId: workloadIdentities[7].properties.principalId, clientId: workloadIdentities[7].properties.clientId, sandboxGroupId: deploySandboxGroups ? sandboxGroupP2.id : '' }
    P3: { principalObjectId: workloadIdentities[8].properties.principalId, clientId: workloadIdentities[8].properties.clientId, sandboxGroupId: deploySandboxGroups ? sandboxGroupP3.id : '' }
  }
}
