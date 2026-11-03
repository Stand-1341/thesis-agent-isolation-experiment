import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import createLiveDeps from './deps-live.mjs';
import {loadExperimentConfigShape,resolveCredentials} from './experiment-config.mjs';

test('live dependencies do not require an unused subscription ID environment variable',async()=>{
  const config=await loadExperimentConfigShape(fileURLToPath(new URL('../config/experiment.example.json',import.meta.url)));
  assert.throws(()=>createLiveDeps({config,env:{}}),error=>{
    assert.match(error.message,/missing live dependency environment/);
    assert.doesNotMatch(error.message,/THESIS_SUBSCRIPTION_ID/);
    return true;
  });
});

test('unverified live verifiers are constructible only in explicitly non-counted pilot mode',async()=>{
  const shape=await loadExperimentConfigShape(fileURLToPath(new URL('../config/experiment.example.json',import.meta.url)));
  const config=structuredClone(shape);
  config.deployments.azure_custom_sessions_hyperv.managementEndpoint='https://thesis-diag-pool.fakeenv.eastus.azurecontainerapps.io';
  config.deployments.azure_custom_sessions_hyperv.fixtureBlobEndpoint='https://fixture123.blob.core.windows.net/';
  config.deployments.azure_custom_sessions_hyperv.resourceUrl='https://resource.example.test';
  config.deployments.azure_custom_sessions_hyperv.collectorUrl='https://collector.example.test';
  const env={THESIS_LOG_ANALYTICS_WORKSPACE_ID:'00000000-0000-0000-0000-000000000001',
    THESIS_DENIAL_DESTINATION_IP:'192.0.2.88',THESIS_VM_SOURCE_IP:'10.0.0.3',THESIS_FLEX_SOURCE_IP:'10.0.1.4',
    THESIS_VM_TARGET_RESOURCE_ID:'/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/vnet',
    THESIS_BLOB_RESOURCE_ID:'/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/fixture/blobServices/default',
    THESIS_SESSION_REGISTRY_URL:'https://fixture123.blob.core.windows.net/session-mappings',
    THESIS_SESSION_CONTROL_PRINCIPAL_ID:'00000000-0000-0000-0000-000000000007',
    THESIS_SESSION_FIXTURE_OWNER_PRINCIPAL_ID:'00000000-0000-0000-0000-000000000008',
    THESIS_SESSION_HEADER_ISOLATION_VERIFIED:'true'};
  for(const route of config.routes) for(const name of Object.values(route.credentials)) env[name]=`test-secret-${name}-0123456789abcdef`;
  const resolved=resolveCredentials(config,env);
  const pilot=createLiveDeps({config:resolved,env,mode:'non_counted_pilot'});
  assert.equal(typeof pilot.blobVerifier,'function');
  assert.equal(typeof pilot.collectorVerifier,'function');
  assert.equal(typeof pilot.resourceVerifier,'function');
  const session=pilot.sessionFactory(resolved.routes.find(route=>route.deployment==='azure_custom_sessions_hyperv'&&route.profile==='P1'));
  assert.equal(typeof session.reset,'function');
  assert.equal(typeof session.execute,'function');
  assert.equal(typeof session.collect,'function');
  assert.match(pilot.notes.join('\n'),/NON-COUNTED PILOT/);
  assert.throws(()=>createLiveDeps({config,env,mode:'measured'}),/verifier pilot gates have not been established/);
});
