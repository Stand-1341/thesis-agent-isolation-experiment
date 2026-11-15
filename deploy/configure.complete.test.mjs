import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveConfiguration, renderExperimentConfig, validateSelectedExperimentConfig} from './configure.mjs';

const subscription = '77777777-7777-4777-8777-777777777777';
const guid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const identityId = name => `/subscriptions/${subscription}/resourceGroups/study/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${name}`;
const routeIdentity = (n, prefix) => ({
  principalObjectId: guid(n), clientId: guid(n + 100),
  workloadIdentityResourceId: identityId(`${prefix}-${n}-workload`),
  secretReaderClientId: guid(n + 200),
  secretReaderIdentityResourceId: identityId(`${prefix}-${n}-secret-reader`),
  workloadTokenSecretUri: `https://study-kv.vault.azure.net/secrets/${prefix}-${n}-workload-token`
});

function completeOutputs() {
  const vm = {};
  const functions = {};
  const sandboxes = {};
  for (const [index, profile] of ['P1', 'P2', 'P3'].entries()) {
    const n = index + 1;
    vm[profile] = {...routeIdentity(n, 'vm'), resourceId: `/subscriptions/${subscription}/resourceGroups/vm-east/providers/Microsoft.Compute/virtualMachines/vm-${profile.toLowerCase()}`};
    functions[profile] = {...routeIdentity(n + 3, 'functions'), resourceId: `/subscriptions/${subscription}/resourceGroups/functions-east/providers/Microsoft.Web/sites/fn-${profile.toLowerCase()}`, agentUrl: `https://fn-${profile.toLowerCase()}.azurewebsites.net/api`};
    sandboxes[profile] = {...routeIdentity(n + 6, 'sandbox'), sandboxGroupId: `/subscriptions/${subscription}/resourceGroups/sandbox-west/providers/Microsoft.App/sandboxGroups/sandbox-${profile.toLowerCase()}`};
  }
  return {
    registryServer: 'thesisacr.azurecr.io',
    controllerIdentityClientId: guid(301), controllerIdentityObjectId: guid(302), verifierIdentityObjectId: guid(303),
    virtualNetworkId: `/subscriptions/${subscription}/resourceGroups/network-east/providers/Microsoft.Network/virtualNetworks/study-vnet`,
    imagePullIdentityResourceId: identityId('image-pull'),
    imagePullIdentityClientId: guid(350),
    researchServicePrivateIp: '10.48.9.4', collectorPrivateIp: '10.48.9.5',
    restrictedServicePrivateIp: '10.48.9.6',
    evidenceAccountId: `/subscriptions/${subscription}/resourceGroups/study/providers/Microsoft.Storage/storageAccounts/studievd`,
    evidenceContainerUrl: 'https://studievd.blob.core.windows.net/trial-evidence',
    fixtureAccountId: `/subscriptions/${subscription}/resourceGroups/study/providers/Microsoft.Storage/storageAccounts/studfix`,
    fixtureBlobEndpoint: 'https://studfix.blob.core.windows.net',
    fixtureBlobResourceId: `/subscriptions/${subscription}/resourceGroups/study/providers/Microsoft.Storage/storageAccounts/studfix/blobServices/default`,
    vmAgentPrivateIps: {P1: '10.48.1.4', P2: '10.49.1.4', P3: '10.48.3.4'},
    sandboxGroupRuntimeSpecs: {defaultCpu: '1', defaultMemory: '1Gi', defaultDisk: '10Gi'},
    sandboxDiskImageNames: {P1: 'agent-p1', P2: 'agent-p2', P3: 'agent-p3'},
    experimentConfigRoutes: {azure_vm: vm, azure_functions_flex: functions, aca_sandboxes: sandboxes},
    routeRegions: {
      azure_vm: {P1: 'eastus2', P2: 'westus2', P3: 'eastus2'},
      azure_functions_flex: {P1: 'eastus2', P2: 'eastus2', P3: 'eastus2'},
      azure_container_apps_sandboxes: {P1: 'westus2', P2: 'westus2', P3: 'westus2'}
    }
  };
}

test('complete resolved values produce a runner-accepted config with outputs-derived resources and endpoints', () => {
  const outputs = completeOutputs();
  const env = {AZURE_SUBSCRIPTION_ID: subscription, AZURE_LOCATION: 'eastus2', AGENT_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`};
  const {problems, resolved} = resolveConfiguration({outputs, env});
  assert.deepEqual(problems, []);
  const rendered = renderExperimentConfig({resolved, env});
  assert.deepEqual(rendered.problems, []);

  const config = validateSelectedExperimentConfig(rendered.config);
  assert.equal(config.routes.length, 9);
  assert.equal(config.deployments.azure_functions_flex.kind, 'http');
  assert.equal(config.deployments.azure_functions_flex.resourceUrl, 'https://10.48.9.4');
  assert.equal(config.routes.find(route => route.deployment === 'azure_functions_flex' && route.profile === 'P1').agentUrl, 'https://fn-p1.azurewebsites.net/api');
  assert.equal(config.deployments.azure_container_apps_sandboxes.resourceGroup, 'sandbox-west');
  assert.deepEqual(config.deployments.azure_container_apps_sandboxes.sandboxGroups, {P1: 'sandbox-p1', P2: 'sandbox-p2', P3: 'sandbox-p3'});
  assert.deepEqual(config.deployments.azure_container_apps_sandboxes.diskImageIds, {P1: 'agent-p1', P2: 'agent-p2', P3: 'agent-p3'});
  assert.deepEqual(config.deployments.azure_container_apps_sandboxes.resources, {cpu: '1vCPU', memory: '1Gi', disk: '10Gi'});
  assert.equal(config.deployments.azure_vm.resourceUrl, 'https://10.48.9.4');
  assert.equal(config.deployments.azure_vm.collectorUrl, 'https://10.48.9.5:8443');
  assert.equal(config.deployments.azure_vm.restrictedUrl, 'https://10.48.9.6:9443');
  assert.equal(config.routes.find(route => route.deployment === 'azure_vm' && route.profile === 'P2').agentUrl, 'https://10.49.1.4');
  assert.deepEqual(config.routes.find(route => route.deployment === 'azure_functions_flex' && route.profile === 'P1').credentials,
    {controller: 'THESIS_FN_P1_CONTROLLER_KEY', resourceAdmin: 'THESIS_RESOURCE_ADMIN_KEY', collectorAdmin: 'THESIS_COLLECTOR_ADMIN_KEY', functionKey: 'THESIS_FN_P1_FUNCTION_KEY'});
  assert.equal(rendered.config.routeRegions.azure_vm.P2, 'westus2');
  assert.equal(rendered.config.deployments.azure_container_apps_sandboxes.region, 'westus2');
});

test('sandbox routes retain per-profile regions and render without a false deployment-wide region',()=>{
  const outputs=completeOutputs();
  outputs.routeRegions.azure_container_apps_sandboxes={P1:'centralus',P2:'centralus',P3:'westus2'};
  const env={AZURE_SUBSCRIPTION_ID:subscription,AZURE_LOCATION:'centralus',AGENT_IMAGE_DIGEST:`sha256:${'b'.repeat(64)}`};
  const resolved=resolveConfiguration({outputs,env});
  assert.deepEqual(resolved.problems,[]);
  const rendered=renderExperimentConfig({resolved:resolved.resolved,env});
  assert.deepEqual(rendered.problems,[]);
  const config=validateSelectedExperimentConfig(rendered.config);
  assert.deepEqual(config.deployments.azure_container_apps_sandboxes.profileRegions,{P1:'centralus',P2:'centralus',P3:'westus2'});
  assert.equal(config.deployments.azure_container_apps_sandboxes.region,undefined);
  assert.equal(config.routeRegions.azure_container_apps_sandboxes.P3,'westus2');
});

test('missing live endpoint and client metadata are rejected instead of filled with placeholders', () => {
  const outputs = completeOutputs();
  delete outputs.vmAgentPrivateIps.P1;
  delete outputs.restrictedServicePrivateIp;
  const env = {AZURE_SUBSCRIPTION_ID: subscription, AZURE_LOCATION: 'eastus2', AGENT_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`};
  const {resolved} = resolveConfiguration({outputs, env});
  const rendered = renderExperimentConfig({resolved, env});
  assert.equal(rendered.config.routes.find(route => route.deployment === 'azure_vm' && route.profile === 'P1').agentUrl, undefined);
  assert.equal(rendered.config.deployments.azure_vm.restrictedUrl, undefined);
  assert.throws(() => validateSelectedExperimentConfig(rendered.config), /agentUrl|restrictedUrl/);
});

test('missing workload client ID is rejected by the runner validator', () => {
  const outputs = completeOutputs();
  delete outputs.experimentConfigRoutes.azure_functions_flex.P1.clientId;
  const env = {AZURE_SUBSCRIPTION_ID: subscription, AZURE_LOCATION: 'eastus2', AGENT_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`};
  const {resolved} = resolveConfiguration({outputs, env});
  const rendered = renderExperimentConfig({resolved, env});
  assert.throws(() => validateSelectedExperimentConfig(rendered.config), /workloadClientId/);
});
