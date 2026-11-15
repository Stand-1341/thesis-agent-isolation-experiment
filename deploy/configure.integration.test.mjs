import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveConfiguration, renderExperimentConfig} from './configure.mjs';
import {validateExperimentConfig} from '../Complete_Thesis_Azure_Package/05-DOCKER-STARTER/scripts/experiment-config.mjs';

test('configure output is checked against the runner contract and fails closed for incomplete ARM routes', () => {
  const outputs = {
    registryServer: 'thesisacr.azurecr.io',
    controllerIdentityClientId: '11111111-1111-1111-1111-111111111111',
    controllerIdentityObjectId: '22222222-2222-2222-2222-222222222222',
    verifierIdentityObjectId: '33333333-3333-3333-3333-333333333333',
    virtualNetworkId: '/subscriptions/x/resourceGroups/y/providers/Microsoft.Network/virtualNetworks/vnet',
    researchServicePrivateIp: '10.48.9.4',
    collectorPrivateIp: '10.48.9.5',
    experimentConfigRoutes: {
      azure_vm: {
        P1: {principalObjectId: '44444444-4444-4444-4444-444444444444'},
        P2: {principalObjectId: '55555555-5555-5555-5555-555555555555'},
        P3: {principalObjectId: '66666666-6666-6666-6666-666666666666'}
      }
    }
  };
  const env = {AZURE_SUBSCRIPTION_ID: '77777777-7777-7777-7777-777777777777', AGENT_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`};
  const {resolved} = resolveConfiguration({outputs, env});
  const {config} = renderExperimentConfig({resolved, env});

  assert.throws(() => validateExperimentConfig(config), /revision-3 routes are required/);
});
