import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolveConfiguration, renderExperimentConfig, validateSelectedExperimentConfig} from './configure.mjs';

test('configure validates against all nine routes in the selected three-arm 450 schedule', () => {
  const outputs = {
    registryServer: 'thesisacr.azurecr.io',
    controllerIdentityClientId: '11111111-1111-1111-1111-111111111111',
    controllerIdentityObjectId: '22222222-2222-2222-2222-222222222222',
    verifierIdentityObjectId: '33333333-3333-3333-3333-333333333333',
    virtualNetworkId: '/subscriptions/x/resourceGroups/y/providers/Microsoft.Network/virtualNetworks/vnet',
    researchServicePrivateIp: '10.48.9.4',
    collectorPrivateIp: '10.48.9.5',
    experimentConfigRoutes: {
      azure_vm: {P1: {principalObjectId: '44444444-4444-4444-4444-444444444444'}, P2: null, P3: null},
      aca_jobs: {P1: {principalObjectId: '55555555-5555-5555-5555-555555555555'}, P2: null, P3: null},
      aca_sandboxes: {P1: {principalObjectId: '66666666-6666-6666-6666-666666666666'}, P2: null, P3: null}
    }
  };
  const env = {AZURE_SUBSCRIPTION_ID: '77777777-7777-7777-7777-777777777777', AGENT_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`};
  const {resolved} = resolveConfiguration({outputs, env});
  const {config} = renderExperimentConfig({resolved, env});

  assert.throws(() => validateSelectedExperimentConfig(config), /at least 9 scheduled deployment\/profile routes are required, got 3/);
});

test('configure maps Bicep arm aliases and carries emitted workload identity metadata', () => {
  const identity = (profile, routePrefix) => ({
    principalObjectId: `00000000-0000-4000-8000-${String(profile + 1).padStart(12, '0')}`,
    clientId: `10000000-0000-4000-8000-${String(profile + 1).padStart(12, '0')}`,
    workloadIdentityResourceId: `/subscriptions/77777777-7777-4777-8777-777777777777/resourceGroups/study/providers/Microsoft.ManagedIdentity/userAssignedIdentities/workload-${profile}`,
    secretReaderClientId: `20000000-0000-4000-8000-${String(profile + 1).padStart(12, '0')}`,
    secretReaderIdentityResourceId: `/subscriptions/77777777-7777-4777-8777-777777777777/resourceGroups/study/providers/Microsoft.ManagedIdentity/userAssignedIdentities/secret-reader-${profile}`,
    workloadTokenSecretUri: `https://study.vault.azure.net/secrets/study-${routePrefix}-p${profile}-workload-token`,
    resourceId: `/subscriptions/77777777-7777-4777-8777-777777777777/resourceGroups/study/providers/Microsoft.App/jobs/job-${profile}`,
    sandboxGroupId: `/subscriptions/77777777-7777-4777-8777-777777777777/resourceGroups/study/providers/Microsoft.App/sandboxGroups/sandbox-${profile}`
  });
  const routes = prefix => ({P1: identity(1, prefix), P2: identity(2, prefix), P3: identity(3, prefix)});
  const outputs = {
    registryServer: 'thesisacr.azurecr.io',
    controllerIdentityClientId: '11111111-1111-1111-1111-111111111111',
    controllerIdentityObjectId: '22222222-2222-2222-2222-222222222222',
    verifierIdentityObjectId: '33333333-3333-3333-3333-333333333333',
    virtualNetworkId: '/subscriptions/x/resourceGroups/y/providers/Microsoft.Network/virtualNetworks/vnet',
    experimentConfigRoutes: {azure_vm: routes('vm'), aca_jobs: routes('job'), aca_sandboxes: routes('sbx')}
  };
  const env = {AZURE_SUBSCRIPTION_ID: '77777777-7777-7777-7777-777777777777', AGENT_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`};
  const {resolved} = resolveConfiguration({outputs, env});
  const {config} = renderExperimentConfig({resolved, env});

  assert.deepEqual(Object.keys(config.deployments), ['azure_vm', 'azure_container_apps_jobs', 'azure_container_apps_sandboxes']);
  assert.equal(config.deployments.azure_container_apps_jobs.kind, 'aca_job');
  assert.equal(config.deployments.azure_container_apps_sandboxes.kind, 'aca_sandbox');
  assert.equal(config.routes.length, 9);
  const jobRoute = config.routes.find(route => route.deployment === 'azure_container_apps_jobs' && route.profile === 'P2');
  assert.equal(jobRoute.workloadClientId, outputs.experimentConfigRoutes.aca_jobs.P2.clientId);
  assert.equal(jobRoute.workloadIdentityResourceId, outputs.experimentConfigRoutes.aca_jobs.P2.workloadIdentityResourceId);
  assert.equal(jobRoute.secretReaderClientId, outputs.experimentConfigRoutes.aca_jobs.P2.secretReaderClientId);
  assert.equal(jobRoute.secretReaderIdentityResourceId, outputs.experimentConfigRoutes.aca_jobs.P2.secretReaderIdentityResourceId);
  assert.equal(jobRoute.workloadTokenSecretUri, 'https://study.vault.azure.net/secrets/study-job-p2-workload-token');
  assert.equal(jobRoute.resourceId, outputs.experimentConfigRoutes.aca_jobs.P2.resourceId);
  assert.equal(new Set(config.routes.map(route => route.workloadTokenSecretUri)).size, 9);
});

test('route secret reader RBAC is scoped to the named existing secret resource', async () => {
  const moduleText = await readFile(new URL('../Complete_Thesis_Azure_Package/05-DOCKER-STARTER/infra/route-secret-reader-rbac.bicep', import.meta.url), 'utf8');
  assert.match(moduleText, /resource tokenSecret 'Microsoft\.KeyVault\/vaults\/secrets@[^']+' existing/);
  assert.match(moduleText, /scope: tokenSecret/);
  assert.doesNotMatch(moduleText, /scope: vault\b/);
  assert.doesNotMatch(moduleText, /Microsoft\.KeyVault\/vaults@[^\n]+\n[\s\S]{0,200}scope: vault\b/);
});

