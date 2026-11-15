#!/usr/bin/env node
/**
 * Auto-configuration: resolve the deployment's real names, endpoints, identity
 * IDs and private IPs from ARM outputs (never hand-copied values) and emit the
 * machine-resolved half of the experiment configuration.
 *
 * Output: .azure/<env>/deployment.resolved.json + a render of the experiment
 * config (config/experiment.generated.json in the starter) referencing real
 * resource IDs. Nothing here prompts a user or accepts a pasted endpoint.
 */
import {readAzdEnv, readInfraOutputs, makeStepLogger, makeAzRunner, formatFailures} from './common.mjs';
import {writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateExperimentConfig} from '../Complete_Thesis_Azure_Package/05-DOCKER-STARTER/scripts/experiment-config.mjs';
import selectedProtocol from '../Complete_Thesis_Azure_Package/05-DOCKER-STARTER/config/protocol-450-flex-sandbox-supported-v3.json' with {type: 'json'};

const SELECTED_ROUTES = selectedProtocol.routeKeys;
const SELECTED_SCENARIOS = selectedProtocol.scenarios.scheduled;
const ARM_ROUTE_NAMES = Object.freeze({aca_jobs: 'azure_container_apps_jobs', aca_sandboxes: 'azure_container_apps_sandboxes'});

function normalizeWorkloadRouteNames(workloads = {}) {
  return Object.fromEntries(Object.entries(workloads).map(([name, profiles]) => [ARM_ROUTE_NAMES[name] ?? name, profiles]));
}

function parseResourceId(value, provider, type) {
  if (typeof value !== 'string') return undefined;
  const match = new RegExp(`^/subscriptions/([^/]+)/resourceGroups/([^/]+)/providers/${provider}/${type}/([^/]+)$`, 'i').exec(value);
  return match ? {subscriptionId: match[1], resourceGroup: match[2], name: match[3]} : undefined;
}

function routeResourceLocation(route, provider, type) {
  return parseResourceId(route?.resourceId ?? route?.sandboxGroupId, provider, type);
}

/** Resolve VM agent IPs from deployed NIC state; ARM's VM route output has IDs, not IPs. */
export async function resolveVmAgentPrivateIps(workloads, {az = makeAzRunner()} = {}) {
  const resolved = {};
  for (const [profile, route] of Object.entries(workloads?.azure_vm ?? {})) {
    if (!route || !route.resourceId) continue;
    const vm = await az(['vm', 'show', '--ids', route.resourceId]);
    const nicId = vm?.networkProfile?.networkInterfaces?.[0]?.id;
    if (!nicId) continue;
    const nic = await az(['network', 'nic', 'show', '--ids', nicId]);
    const ip = nic?.ipConfigurations?.[0]?.privateIPAddress;
    if (ip) resolved[profile] = ip;
  }
  return resolved;
}

/** Validate against the frozen 450-row three-arm schedule, not the legacy VM/Functions default. */
export function validateSelectedExperimentConfig(config) {
  return validateExperimentConfig(config, {requiredRoutes: SELECTED_ROUTES, requiredScenarios: SELECTED_SCENARIOS});
}

const STARTER = path.resolve('Complete_Thesis_Azure_Package/05-DOCKER-STARTER');

/** Pure: fold ARM outputs + env into the resolved deployment document. */
export function resolveConfiguration({outputs, env, sourceTreeDigest} = {}) {
  const problems = [];
  const hasMultiRegionMarker = outputs?.multiRegion === true || outputs?.multiRegionMarker === true ||
    outputs?.deploymentTopology === 'multi-region' || outputs?.routeRegions !== undefined;
  const required = ['registryServer', 'controllerIdentityClientId', 'controllerIdentityObjectId', 'verifierIdentityObjectId', 'experimentConfigRoutes', 'virtualNetworkId', 'fixtureBlobResourceId'];
  for (const key of required) {
    if (!outputs?.[key]) problems.push(`infra output missing: ${key}`);
  }
  const routes = outputs?.experimentConfigRoutes ?? {};
  for (const [arm, profiles] of Object.entries(routes)) {
    for (const [profile, route] of Object.entries(profiles ?? {})) {
      if (route === null) continue; // not deployed (e.g. P3 firewall off)
      if (!route?.principalObjectId) problems.push(`route ${arm}/${profile} has no workload principal — identity not provisioned`);
    }
  }
  if (!env.AZURE_SUBSCRIPTION_ID) problems.push('AZURE_SUBSCRIPTION_ID not set');

  const normalizedRoutes = normalizeWorkloadRouteNames(routes);
  const jobLocations = Object.fromEntries(Object.entries(normalizedRoutes.azure_container_apps_jobs ?? {}).map(([profile, route]) =>
    [profile, routeResourceLocation(route, 'Microsoft.App', 'jobs')]));
  const jobLocation = jobLocations.P1;
  const sandboxLocations = Object.fromEntries(Object.entries(normalizedRoutes.azure_container_apps_sandboxes ?? {}).map(([profile, route]) =>
    [profile, routeResourceLocation(route, 'Microsoft.App', 'sandboxGroups')]));
  const routeRegions = {};
  for (const [arm, profiles] of Object.entries(normalizedRoutes)) {
    const rawArm = Object.keys(routes).find(key => (ARM_ROUTE_NAMES[key] ?? key) === arm);
    const sourceRegions = outputs?.routeRegions?.[arm] ?? outputs?.routeRegions?.[rawArm] ?? {};
    routeRegions[arm] = Object.fromEntries(Object.keys(profiles ?? {}).map(profile => [profile,
      profiles[profile]?.region ?? (typeof sourceRegions === 'string' ? sourceRegions : sourceRegions?.[profile] ?? sourceRegions?.[profile.toLowerCase()]) ??
        (!hasMultiRegionMarker ? (outputs?.location ?? env.AZURE_LOCATION ?? 'centralus') : undefined)]));
    const specified = Object.values(routeRegions[arm]).filter(Boolean);
    if (!specified.length && hasMultiRegionMarker)
      problems.push(`route region metadata missing for multi-region deployment arm ${arm}`);
    if (specified.length && Object.keys(profiles ?? {}).some(profile => profiles[profile] && !routeRegions[arm][profile]))
      problems.push(`route region metadata is incomplete for deployment arm ${arm}`);
  }
  const subscriptionId = env.AZURE_SUBSCRIPTION_ID;
  if (outputs?.restrictedServicePrivateIp && outputs?.restrictedServicePolicyIp && outputs.restrictedServicePrivateIp !== outputs.restrictedServicePolicyIp)
    problems.push('restricted service endpoint IP does not match the P3 firewall deny target');
  for (const [profile, location] of Object.entries(jobLocations)) {
    if (location && subscriptionId && location.subscriptionId.toLowerCase() !== subscriptionId.toLowerCase())
      problems.push(`ACA Job ${profile} resource ID subscription does not match AZURE_SUBSCRIPTION_ID`);
  }
  const jobResourceGroups = new Set(Object.values(jobLocations).filter(Boolean).map(location => location.resourceGroup.toLowerCase()));
  if (jobResourceGroups.size > 1)
    problems.push('ACA Jobs span resource groups, but the runner accepts one resource group per deployment');
  for (const [profile, location] of Object.entries(sandboxLocations)) {
    if (location && subscriptionId && location.subscriptionId.toLowerCase() !== subscriptionId.toLowerCase())
      problems.push(`sandbox group ${profile} resource ID subscription does not match AZURE_SUBSCRIPTION_ID`);
  }
  const sandboxResourceGroups = new Set(Object.values(sandboxLocations).filter(Boolean).map(location => location.resourceGroup.toLowerCase()));
  if (sandboxResourceGroups.size > 1)
    problems.push('sandbox groups span resource groups, but the runner accepts one resource group per deployment');

  const resolved = {
    resolvedAt: new Date().toISOString(),
    source: 'ARM deployment outputs',
    subscriptionId,
    location: env.AZURE_LOCATION ?? outputs?.location ?? 'centralus',
    routeRegions,
    hasMultiRegionMarker,
    registry: {
      server: outputs?.registryServer,
      agentImage: env.AGENT_IMAGE_DIGEST ? `${outputs?.registryServer}/thesis/agent@${env.AGENT_IMAGE_DIGEST}` : undefined,
      sourceTreeDigest: sourceTreeDigest
    },
    network: {
      virtualNetworkId: outputs?.virtualNetworkId,
      researchServicePrivateIp: outputs?.researchServicePrivateIp,
      collectorPrivateIp: outputs?.collectorPrivateIp,
      restrictedServicePrivateIp: outputs?.restrictedServicePrivateIp,
      restrictedServicePolicyIp: outputs?.restrictedServicePolicyIp,
      researchHostResourceId: outputs?.researchHostResourceId
    },
    identities: {
      controller: {clientId: outputs?.controllerIdentityClientId, objectId: outputs?.controllerIdentityObjectId},
      verifier: {objectId: outputs?.verifierIdentityObjectId},
      secretReader: {objectId: outputs?.secretReaderIdentityObjectId},
      fixtureOwner: {objectId: outputs?.fixtureOwnerIdentityObjectId},
      sandboxControl: {clientId: outputs?.sandboxControlIdentityClientId},
      imagePull: {resourceId: outputs?.imagePullIdentityResourceId}
    },
    evidence: {accountId: outputs?.evidenceAccountId, containerUrl: outputs?.evidenceContainerUrl},
    fixtures: {accountId: outputs?.fixtureAccountId, blobEndpoint: outputs?.fixtureBlobEndpoint,
      blobResourceId: outputs?.fixtureBlobResourceId},
    // The Bicep output preserves concise historical arm labels. Normalize them
    // to the exact deployment names consumed by the selected runner protocol.
    workloads: normalizedRoutes,
    sandboxDiskImageNames: outputs?.sandboxDiskImageNames,
    sandboxGroupRuntimeSpecs: outputs?.sandboxGroupRuntimeSpecs,
    vmAgentPrivateIps: outputs?.vmAgentPrivateIps,
    environments: {jobs: outputs?.jobsEnvironmentId, jobsP3: outputs?.jobsP3EnvironmentId},
    observability: {logWorkspaceId: outputs?.logWorkspaceId}
  };
  return {problems, resolved};
}

/** Pure: render the experiment-facing config that the runner/verifier consume. */
export function renderExperimentConfig({resolved, env} = {}) {
  const problems = [];
  const routes = resolved.workloads ?? {};
  const config = {
    generatedAt: resolved.resolvedAt,
    generatedFrom: 'deploy/configure.mjs — ARM outputs only; do not hand-edit generated fields',
    subscriptionId: resolved.subscriptionId,
    region: resolved.location,
    agentImage: resolved.registry.agentImage,
    evidence: resolved.evidence,
    fixtures: resolved.fixtures,
    // Match the experiment runner's config contract (deployments map + routes
    // array). Keep ARM-only fields alongside that contract for deploy tools.
    evidenceDirectory: 'results/evidence',
    auditWindowSeconds: 3600,
    deployments: {},
    serviceEndpoints: {
      ...(resolved.network.researchServicePrivateIp ? {research: {privateIp: resolved.network.researchServicePrivateIp, port: 443, tls: 'in-cluster CA (research-proxy)'}} : {}),
      ...(resolved.network.collectorPrivateIp ? {collector: {privateIp: resolved.network.collectorPrivateIp, port: 8443}} : {}),
      ...(resolved.network.restrictedServicePrivateIp ? {restricted: {privateIp: resolved.network.restrictedServicePrivateIp, port: 9443}} : {})
    },
    routes: []
  };
  config.routeRegions = resolved.routeRegions ?? {};
  for (const [arm, profiles] of Object.entries(routes)) {
    config.deployments[arm] = {
      kind: arm === 'azure_container_apps_jobs' ? 'aca_job' : arm === 'azure_container_apps_sandboxes' ? 'aca_sandbox' : arm === 'azure_custom_sessions_hyperv' ? 'session' : 'http',
      sessionDataStore: 'azure_blob_external_namespace',
      ...(arm === 'azure_vm' && resolved.vmAgentPrivateIps?.P1 ? {agentUrl: `https://${resolved.vmAgentPrivateIps.P1}`} : {}),
      resourceUrl: resolved.network.researchServicePrivateIp ? `https://${resolved.network.researchServicePrivateIp}:443` : undefined,
      collectorUrl: resolved.network.collectorPrivateIp ? `https://${resolved.network.collectorPrivateIp}:8443` : undefined,
      restrictedUrl: resolved.network.restrictedServicePrivateIp ? `https://${resolved.network.restrictedServicePrivateIp}:9443` : undefined,
      agentImage: resolved.registry.agentImage
    };
    if (arm === 'azure_container_apps_jobs' || arm === 'azure_container_apps_sandboxes') {
      const group = arm === 'azure_container_apps_jobs'
        ? routeResourceLocation(profiles?.P1, 'Microsoft.App', 'jobs')?.resourceGroup
        : Object.values(sandboxLocationsForRender(profiles)).find(Boolean)?.resourceGroup;
      const subscription = arm === 'azure_container_apps_jobs'
        ? routeResourceLocation(profiles?.P1, 'Microsoft.App', 'jobs')?.subscriptionId
        : Object.values(sandboxLocationsForRender(profiles)).find(Boolean)?.subscriptionId;
      const common = {
        subscriptionId: subscription,
        resourceGroup: group,
        agentImage: resolved.registry.agentImage,
        imagePullIdentityResourceId: resolved.identities.imagePull.resourceId,
        resources: arm === 'azure_container_apps_jobs' ? {cpu: 1, memory: '2Gi'} : {
          cpu: sandboxCpuValue(resolved.sandboxGroupRuntimeSpecs?.defaultCpu),
          memory: resolved.sandboxGroupRuntimeSpecs?.defaultMemory,
          disk: resolved.sandboxGroupRuntimeSpecs?.defaultDisk
        },
        resourceUrl: config.deployments[arm].resourceUrl,
        collectorUrl: config.deployments[arm].collectorUrl,
        restrictedUrl: config.deployments[arm].restrictedUrl,
        sessionDataStore: 'azure_blob_external_namespace'
      };
      if (arm === 'azure_container_apps_jobs') Object.assign(config.deployments[arm], {
        ...common, workloadProfileName: 'Consumption',
        jobNames: Object.fromEntries(Object.entries(profiles ?? {}).filter(([, route]) => route).map(([profile, route]) =>
          [profile, routeResourceLocation(route, 'Microsoft.App', 'jobs')?.name])),
        apiVersion: '2026-07-01', executionTimeoutMs: 1800000, logWaitMs: 600000
      });
      else Object.assign(config.deployments[arm], {
        ...common,
        profileRegions: resolved.routeRegions?.[arm] ?? {},
        ...(new Set(Object.values(resolved.routeRegions?.[arm] ?? {}).filter(Boolean)).size <= 1 &&
          (Object.values(resolved.routeRegions?.[arm] ?? {}).some(Boolean) || !resolved.hasMultiRegionMarker)
          ? {region: Object.values(resolved.routeRegions?.[arm] ?? {}).find(Boolean) ?? resolved.location}
          : {}),
        sandboxGroups: Object.fromEntries(Object.entries(profiles ?? {}).filter(([, route]) => route).map(([profile, route]) =>
          [profile, routeResourceLocation(route, 'Microsoft.App', 'sandboxGroups')?.name])),
        diskImageIds: Object.fromEntries(Object.entries(profiles ?? {}).filter(([, route]) => route).map(([profile]) =>
          [profile, resolved.sandboxDiskImageNames?.[profile]])),
        apiVersion: '2026-02-01-preview', timeoutMs: 300000
      });
    }
    for (const [profile, route] of Object.entries(profiles ?? {})) {
      if (route === null) continue;
      config.routes.push({
        deployment: arm,
        profile,
        principalObjectId: route.principalObjectId,
        ...(route.clientId ? {workloadClientId: route.clientId} : {}),
        ...(route.workloadIdentityResourceId ? {workloadIdentityResourceId: route.workloadIdentityResourceId} : {}),
        ...(route.secretReaderClientId ? {secretReaderClientId: route.secretReaderClientId} : {}),
        ...(route.secretReaderIdentityResourceId ? {secretReaderIdentityResourceId: route.secretReaderIdentityResourceId} : {}),
        ...(route.workloadTokenSecretUri ? {workloadTokenSecretUri: route.workloadTokenSecretUri} : {}),
        ...(route.resourceId ? {resourceId: route.resourceId} : {}),
        ...(route.sandboxGroupId ? {sandboxGroupId: route.sandboxGroupId} : {}),
        ...(arm === 'azure_vm' && resolved.vmAgentPrivateIps?.[profile] ? {agentUrl: `https://${resolved.vmAgentPrivateIps[profile]}`} : {}),
        ...(arm === 'azure_functions_flex' && route.agentUrl ? {agentUrl: route.agentUrl} : {}),
        credentials: routeCredentials(arm, profile)
      });
    }
  }
  if (!config.agentImage) problems.push('agent image reference unresolved (AGENT_IMAGE_DIGEST missing from environment)');
  const deployedCount = config.routes.length;
  if (deployedCount === 0) problems.push('no workload routes resolved — was the full stage provisioned?');
  return {problems, config};
}

function sandboxLocationsForRender(profiles) {
  return Object.fromEntries(Object.entries(profiles ?? {}).map(([profile, route]) =>
    [profile, routeResourceLocation(route, 'Microsoft.App', 'sandboxGroups')]));
}

function routeCredentials(arm, profile) {
  const p = profile.toUpperCase();
  if (arm === 'azure_vm') return {controller: `THESIS_VM_${p}_CONTROLLER_KEY`, resourceAdmin: 'THESIS_RESOURCE_ADMIN_KEY', collectorAdmin: 'THESIS_COLLECTOR_ADMIN_KEY'};
  if (arm === 'azure_functions_flex') return {controller: `THESIS_FN_${p}_CONTROLLER_KEY`, resourceAdmin: 'THESIS_RESOURCE_ADMIN_KEY', collectorAdmin: 'THESIS_COLLECTOR_ADMIN_KEY', functionKey: `THESIS_FN_${p}_FUNCTION_KEY`};
  if (arm === 'azure_container_apps_jobs') return {resourceAdmin: 'THESIS_JOBS_RESOURCE_ADMIN_KEY', collectorAdmin: 'THESIS_JOBS_COLLECTOR_ADMIN_KEY'};
  if (arm === 'azure_container_apps_sandboxes') return {resourceAdmin: 'THESIS_SANDBOX_RESOURCE_ADMIN_KEY', collectorAdmin: 'THESIS_SANDBOX_COLLECTOR_ADMIN_KEY'};
  return {};
}

function sandboxCpuValue(value) {
  return typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? `${value}vCPU` : value;
}

export async function main({env = process.env, stdout = process.stdout, stderr = process.stderr, outputs} = {}) {
  const log = makeStepLogger({stream: stdout});
  const values = await readAzdEnv(env);
  let armOutputs = outputs ?? await readInfraOutputs().catch(error => {
    stderr.write(`configure: cannot read azd infra outputs: ${error.message}\n`);
    return undefined;
  });
  if (!armOutputs) return 5;

  if (!armOutputs.vmAgentPrivateIps) {
    try {
      armOutputs = {...armOutputs, vmAgentPrivateIps: await resolveVmAgentPrivateIps(normalizeWorkloadRouteNames(armOutputs.experimentConfigRoutes))};
    } catch (error) {
      stderr.write(`configure: could not resolve VM agent NIC addresses: ${error.message}\n`);
      armOutputs = {...armOutputs, vmAgentPrivateIps: {}};
    }
  }

  const {problems, resolved} = resolveConfiguration({outputs: armOutputs, env: values});
  const rendered = renderExperimentConfig({resolved, env: values});
  const allProblems = [...problems, ...rendered.problems];
  // Keep the generated document behind the exact contract used by the runner.
  // ARM outputs currently do not contain all runner fields (for example the
  // scheduled Functions routes and HTTP agent endpoints), so fail before writing
  // a plausible-looking but unusable config.
  try {
    validateSelectedExperimentConfig(rendered.config);
  } catch (error) {
    allProblems.push(`generated experiment config rejected by runner: ${error.message}`);
  }
  if (allProblems.length) {
    stderr.write(formatFailures('Auto-configuration could not resolve the deployment:', allProblems.map(p => ({check: 'configure', problem: p}))) + '\n');
    return 4;
  }

  const envDir = path.join(process.cwd(), '.azure', process.env.AZURE_ENV_NAME ?? values.AZURE_ENV_NAME ?? 'default');
  await mkdir(envDir, {recursive: true});
  await writeFile(path.join(envDir, 'deployment.resolved.json'), `${JSON.stringify(resolved, null, 2)}\n`);
  await writeFile(path.join(STARTER, 'config', 'experiment.generated.json'), `${JSON.stringify(rendered.config, null, 2)}\n`);
  log('configure', 'resolved', {note: `${rendered.config.routes.length} workload routes, image ${String(resolved.registry.agentImage).slice(-19)}…`});
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
