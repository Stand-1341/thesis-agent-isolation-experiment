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
  config.deployments.azure_custom_sessions_hyperv.sessionRegistryUrl='https://fixture123.blob.core.windows.net/session-mappings';
  const env={THESIS_LOG_ANALYTICS_WORKSPACE_ID:'00000000-0000-0000-0000-000000000001',
    THESIS_FIXTURE_BLOB_ENDPOINT:'https://fixture.blob.core.windows.net',
    THESIS_BLOB_RESOURCE_ID:'/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/fixture/blobServices/default',
    THESIS_DENIAL_DESTINATION_IP:'192.0.2.88',THESIS_VM_SOURCE_IP:'10.0.0.3',THESIS_FLEX_SOURCE_IP:'10.0.1.4',
    THESIS_VM_TARGET_RESOURCE_ID:'/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/vnet',
    THESIS_BLOB_RESOURCE_ID:'/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/fixture/blobServices/default',
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
  const scopedEnv={...env};
  for(const name of ['THESIS_DENIAL_DESTINATION_IP','THESIS_VM_TARGET_RESOURCE_ID','THESIS_SESSION_CONTROL_PRINCIPAL_ID',
    'THESIS_SESSION_FIXTURE_OWNER_PRINCIPAL_ID','THESIS_SESSION_HEADER_ISOLATION_VERIFIED']) delete scopedEnv[name];
  const scoped=createLiveDeps({config:resolved,env:scopedEnv,mode:'non_counted_pilot',routeKeys:new Set(['azure_vm:P1'])});
  assert.equal(scoped.sessionFactory,undefined);
  assert.equal(scoped.denialReader.capabilities.azure_vm,false);
  const managedEnv={...scopedEnv,THESIS_TOKEN_PROVIDER_MODE:'managed_identity',
    THESIS_STORAGE_IDENTITY_CLIENT_ID:'00000000-0000-4000-8000-000000000009',
    THESIS_LOGS_IDENTITY_CLIENT_ID:'00000000-0000-4000-8000-000000000010'};
  const managed=createLiveDeps({config:resolved,env:managedEnv,mode:'non_counted_pilot',routeKeys:new Set(['azure_vm:P1'])});
  assert.equal(typeof managed.blobVerifier,'function');
  assert.throws(()=>createLiveDeps({config,env,mode:'measured'}),/verifier pilot gates have not been established/);
});

test('live verifiers select endpoint and verifier secret from the trial deployment',async()=>{
  const shape=await loadExperimentConfigShape(fileURLToPath(new URL('../config/experiment.example.json',import.meta.url)));
  shape.deployments.azure_functions_flex.resourceUrl='https://resource-functions.example';
  shape.deployments.azure_functions_flex.collectorUrl='https://collector-functions.example';
  const routeKeys=new Set(['azure_functions_flex:P1']);
  const env={THESIS_LOG_ANALYTICS_WORKSPACE_ID:'00000000-0000-0000-0000-000000000001',
    THESIS_BLOB_RESOURCE_ID:'/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/fixture/blobServices/default',
    THESIS_FIXTURE_BLOB_ENDPOINT:'https://fixture.blob.core.windows.net',
    THESIS_AZURE_FUNCTIONS_FLEX_RESOURCE_VERIFIER_KEY:'resource-verifier-secret',
    THESIS_AZURE_FUNCTIONS_FLEX_COLLECTOR_VERIFIER_KEY:'collector-verifier-secret',
    THESIS_AZURE_FUNCTIONS_FLEX_VERIFIER_KEY:'shared-fallback-secret'};
  for(const route of shape.routes.filter(route=>routeKeys.has(`${route.deployment}:${route.profile}`)))
    for(const name of Object.values(route.credentials)) env[name]=`pilot-secret-${name}-0123456789`;
  const config=resolveCredentials(shape,env,routeKeys);
  const deps=createLiveDeps({config,env,mode:'non_counted_pilot',routeKeys});
  const originalFetch=globalThis.fetch,seen=[];
  globalThis.fetch=async(url,options)=>{seen.push({url:String(url),token:options.headers['x-verifier-token']});return new Response(JSON.stringify({events:[]}));};
  try {
    const start='2026-01-01T00:00:10Z',end='2026-01-01T00:00:12Z';
    const common={deployment:'azure_functions_flex',profile:'P1',runId:'run-functions-p1',scenario:'U4'};
    await deps.resourceVerifier(common,{output:{runId:common.runId,scenario:'U4',transportOk:true,status:200,body:{}},timing:{executionStartedAt:start,executionFinishedAt:end}});
    await deps.collectorVerifier({...common,scenario:'U5'},{reset:{},output:{runId:common.runId,scenario:'U5'},timing:{executionStartedAt:start,executionFinishedAt:end}});
    assert.deepEqual(seen,[
      {url:'https://resource-functions.example/admin/evidence?runId=run-functions-p1',token:'resource-verifier-secret'},
      {url:'https://collector-functions.example/admin/evidence?runId=run-functions-p1',token:'collector-verifier-secret'}
    ]);
  } finally {globalThis.fetch=originalFetch;}
});
