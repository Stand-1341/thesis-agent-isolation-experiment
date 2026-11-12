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
import {readAzdEnv, readInfraOutputs, makeStepLogger, makeCheckpointStore, resolveStatePath, formatFailures} from './common.mjs';
import {writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const STARTER = path.resolve('Complete_Thesis_Azure_Package/05-DOCKER-STARTER');

/** Pure: fold ARM outputs + env into the resolved deployment document. */
export function resolveConfiguration({outputs, env, sourceTreeDigest} = {}) {
  const problems = [];
  const required = ['registryServer', 'controllerIdentityClientId', 'controllerIdentityObjectId', 'verifierIdentityObjectId', 'experimentConfigRoutes', 'virtualNetworkId'];
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

  const resolved = {
    resolvedAt: new Date().toISOString(),
    source: 'ARM deployment outputs',
    subscriptionId: env.AZURE_SUBSCRIPTION_ID,
    location: env.AZURE_LOCATION ?? 'centralus',
    registry: {
      server: outputs?.registryServer,
      agentImage: env.AGENT_IMAGE_DIGEST ? `${outputs?.registryServer}/thesis/agent@${env.AGENT_IMAGE_DIGEST}` : undefined,
      sourceTreeDigest: sourceTreeDigest
    },
    network: {
      virtualNetworkId: outputs?.virtualNetworkId,
      researchServicePrivateIp: outputs?.researchServicePrivateIp,
      collectorPrivateIp: outputs?.collectorPrivateIp
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
    fixtures: {accountId: outputs?.fixtureAccountId, blobEndpoint: outputs?.fixtureBlobEndpoint},
    workloads: outputs?.experimentConfigRoutes,
    sandboxDiskImageNames: outputs?.sandboxDiskImageNames,
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
    serviceEndpoints: {
      research: {privateIp: resolved.network.researchServicePrivateIp, port: 443, tls: 'in-cluster CA (research-proxy)'},
      collector: {privateIp: resolved.network.collectorPrivateIp}
    },
    routes: {}
  };
  for (const [arm, profiles] of Object.entries(routes)) {
    config.routes[arm] = {};
    for (const [profile, route] of Object.entries(profiles ?? {})) {
      if (route === null) { config.routes[arm][profile] = {deployed: false}; continue; }
      config.routes[arm][profile] = {
        deployed: true,
        principalObjectId: route.principalObjectId,
        ...(route.clientId ? {clientId: route.clientId} : {}),
        ...(route.resourceId ? {resourceId: route.resourceId} : {}),
        ...(route.sandboxGroupId ? {sandboxGroupId: route.sandboxGroupId} : {})
      };
    }
  }
  if (!config.agentImage) problems.push('agent image reference unresolved (AGENT_IMAGE_DIGEST missing from environment)');
  const deployedCount = Object.values(config.routes).flatMap(Object.values).filter(r => r.deployed).length;
  if (deployedCount === 0) problems.push('no workload routes resolved — was the full stage provisioned?');
  return {problems, config};
}

export async function main({env = process.env, stdout = process.stdout, stderr = process.stderr, outputs} = {}) {
  const log = makeStepLogger({stream: stdout});
  const values = await readAzdEnv(env);
  const armOutputs = outputs ?? await readInfraOutputs().catch(error => {
    stderr.write(`configure: cannot read azd infra outputs: ${error.message}\n`);
    return undefined;
  });
  if (!armOutputs) return 5;

  const {problems, resolved} = resolveConfiguration({outputs: armOutputs, env: values});
  const rendered = renderExperimentConfig({resolved, env: values});
  const allProblems = [...problems, ...rendered.problems];
  if (allProblems.length) {
    stderr.write(formatFailures('Auto-configuration could not resolve the deployment:', allProblems.map(p => ({check: 'configure', problem: p}))) + '\n');
    return 4;
  }

  const envDir = path.join(process.cwd(), '.azure', process.env.AZURE_ENV_NAME ?? values.AZURE_ENV_NAME ?? 'default');
  await mkdir(envDir, {recursive: true});
  await writeFile(path.join(envDir, 'deployment.resolved.json'), `${JSON.stringify(resolved, null, 2)}\n`);
  await writeFile(path.join(STARTER, 'config', 'experiment.generated.json'), `${JSON.stringify(rendered.config, null, 2)}\n`);
  log('configure', 'resolved', {note: `${Object.values(rendered.config.routes).flatMap(Object.values).filter(r => r.deployed).length} workload routes, image ${String(resolved.registry.agentImage).slice(-19)}…`});
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
