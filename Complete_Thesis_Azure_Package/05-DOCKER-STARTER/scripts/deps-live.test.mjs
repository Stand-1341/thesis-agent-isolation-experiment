import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import createLiveDeps,{principalForConfiguredTrial} from './deps-live.mjs';
import {loadExperimentConfigShape,resolveCredentials} from './experiment-config.mjs';

test('session factories bind each profile to its own configured pool and require distinct token providers',()=>{
  const credentials={controller:'c'.repeat(40),resourceAdmin:'r'.repeat(40),collectorAdmin:'a'.repeat(40)};
  const routes=[{deployment:'azure_custom_sessions_hyperv',profile:'P1',principalObjectId:'00000000-0000-4000-8000-000000000001',credentials},
    {deployment:'azure_custom_sessions_hyperv',profile:'P2',principalObjectId:'00000000-0000-4000-8000-000000000002',credentials}];
  const deployment={kind:'session',resourceUrl:'https://research.example.com',collectorUrl:'https://collector.example.com',
    fixtureBlobEndpoint:'https://fixture.blob.core.windows.net',sessionRegistryUrl:'https://registry.blob.core.windows.net/session-mappings',
    profilePools:{P1:{poolName:'pool1',region:'eastus',managementEndpoint:'https://pool1.env.eastus.azurecontainerapps.io'},
      P2:{poolName:'pool2',region:'eastus',managementEndpoint:'https://wrong.env.eastus.azurecontainerapps.io'}}};
  const config={deployments:{azure_custom_sessions_hyperv:deployment},routes};
  const env={THESIS_LOG_ANALYTICS_WORKSPACE_ID:'00000000-0000-4000-8000-000000000003',THESIS_FIXTURE_BLOB_ENDPOINT:'https://fixture.blob.core.windows.net',
    THESIS_BLOB_RESOURCE_ID:'/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/fixture/blobServices/default',
    THESIS_TOKEN_PROVIDER_MODE:'managed_identity',THESIS_STORAGE_IDENTITY_CLIENT_ID:'00000000-0000-4000-8000-000000000004',
    THESIS_LOGS_IDENTITY_CLIENT_ID:'00000000-0000-4000-8000-000000000005',THESIS_SESSION_IDENTITY_CLIENT_ID:'00000000-0000-4000-8000-000000000006',
    THESIS_SESSION_FIXTURE_OWNER_IDENTITY_CLIENT_ID:'00000000-0000-4000-8000-000000000007',
    THESIS_SESSION_CONTROL_PRINCIPAL_ID:'00000000-0000-4000-8000-000000000008',
    THESIS_SESSION_FIXTURE_OWNER_PRINCIPAL_ID:'00000000-0000-4000-8000-000000000009',THESIS_SESSION_HEADER_ISOLATION_VERIFIED:'true'};
  assert.throws(()=>createLiveDeps({config,env:{...env,THESIS_TOKEN_PROVIDER_MODE:'azure_cli'},mode:'non_counted_pilot'}),/separate managed control/);
  assert.throws(()=>createLiveDeps({config,env:{...env,THESIS_SESSION_FIXTURE_OWNER_IDENTITY_CLIENT_ID:''},mode:'non_counted_pilot'}),/THESIS_SESSION_FIXTURE_OWNER_IDENTITY_CLIENT_ID/);
  assert.throws(()=>createLiveDeps({config,env:{...env,THESIS_SESSION_FIXTURE_OWNER_IDENTITY_CLIENT_ID:env.THESIS_SESSION_IDENTITY_CLIENT_ID},mode:'non_counted_pilot'}),/different managed identities/);
  const deps=createLiveDeps({config,env,mode:'non_counted_pilot'});
  assert.equal(typeof deps.sessionFactory(routes[0]).execute,'function');
  assert.throws(()=>deps.sessionFactory(routes[1]),/pool|endpoint|hostname/i);
  assert.throws(()=>deps.sessionFactory({...routes[0],principalObjectId:routes[1].principalObjectId}),/principal does not match/);
});

test('Blob verifier principal resolution accepts scheduled profile field and rejects conflicting labels',async()=>{
  const config=await loadExperimentConfigShape(fileURLToPath(new URL('../config/experiment.azure-live.json',import.meta.url)));
  const expected=config.routes.find(route=>route.deployment==='azure_functions_flex'&&route.profile==='P1').principalObjectId;
  assert.equal(principalForConfiguredTrial(config,{
    deployment:'azure_functions_flex',permission_profile:'P1',scenario:'U2'
  }),expected);
  assert.equal(principalForConfiguredTrial(config,{
    deployment:'azure_functions_flex',profile:'P1',permission_profile:'P1',scenario:'U2'
  }),expected);
  assert.throws(()=>principalForConfiguredTrial(config,{
    deployment:'azure_functions_flex',profile:'P3',permission_profile:'P1',scenario:'U2'
  }),/profile fields disagree/);
  assert.throws(()=>principalForConfiguredTrial(config,{
    deployment:'azure_functions_flex',scenario:'U2'
  }),/deployment\/profile is missing/);
});

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
  assert.equal(typeof pilot.httpFactory,'function');
  const functionsRoute=resolved.routes.find(route=>route.deployment==='azure_functions_flex'&&route.profile==='P1');
  const functionsAdapter=pilot.httpFactory(functionsRoute,resolved.deployments.azure_functions_flex);
  assert.equal(typeof functionsAdapter.reset,'function');
  assert.equal(typeof functionsAdapter.execute,'function');
  assert.equal(typeof functionsAdapter.collect,'function');
  assert.equal(pilot.sessionFactory,undefined);
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

test('VM/Functions-only Rev4 measured dependencies do not require the retired session-header assertion',async()=>{
  const path=fileURLToPath(new URL('../config/experiment.azure-live.json',import.meta.url));
  const shape=await loadExperimentConfigShape(path);
  const env={THESIS_LOG_ANALYTICS_WORKSPACE_ID:'00000000-0000-4000-8000-000000000001',
    THESIS_FIXTURE_BLOB_ENDPOINT:'https://fixture.blob.core.windows.net',
    THESIS_BLOB_RESOURCE_ID:'/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/fixture/blobServices/default',
    THESIS_DENIAL_DESTINATION_IP:'10.48.9.5',THESIS_VM_P3_DENIAL_TELEMETRY:'azure_diagnostics_firewall',
    THESIS_VM_P3_FIREWALL_SOURCE_IP:'10.49.8.4',THESIS_VM_P3_FIREWALL_DESTINATION_PORT:'8443',
    THESIS_VM_P3_FIREWALL_DENY_RULE:'deny-centralus-p3-collector',
    THESIS_FLEX_P3_DENIAL_TELEMETRY:'azure_diagnostics_firewall',THESIS_FLEX_P3_FIREWALL_SOURCE_CIDR:'10.48.6.0/24',
    THESIS_FLEX_P3_FIREWALL_DESTINATION_PORT:'8443',THESIS_FLEX_P3_FIREWALL_DENY_RULE:'functions-p3-deny-collector',
    THESIS_AZURE_VM_RESOURCE_VERIFIER_KEY:'resource-verifier-secret',
    THESIS_AZURE_VM_COLLECTOR_VERIFIER_KEY:'collector-verifier-secret',
    THESIS_AZURE_FUNCTIONS_FLEX_RESOURCE_VERIFIER_KEY:'functions-resource-verifier-secret',
    THESIS_AZURE_FUNCTIONS_FLEX_COLLECTOR_VERIFIER_KEY:'functions-collector-verifier-secret',
    THESIS_COLLECTOR_INDEPENDENTLY_VALIDATED:'true',THESIS_RESOURCE_INDEPENDENTLY_VALIDATED:'true',
    THESIS_CLOCK_SYNC_VALIDATED:'true',THESIS_AUDIT_PIPELINE_VALIDATED:'true',
    THESIS_AUTHORIZATION_VALIDATED:'true',THESIS_DENIAL_STATUS_TEXT_VALIDATED:'true'};
  for(const route of shape.routes) for(const name of Object.values(route.credentials))
    env[name]=`measured-route-secret-${name}-0123456789abcdef`;
  const routes=new Set(shape.routes.map(route=>`${route.deployment}:${route.profile}`));
  const config=resolveCredentials(shape,env,routes);
  const deps=createLiveDeps({config,env,mode:'measured',routeKeys:routes});
  assert.equal(typeof deps.httpFactory,'function');
  assert.equal(deps.sessionFactory,undefined);
  assert.equal(env.THESIS_SESSION_HEADER_ISOLATION_VERIFIED,undefined);
});
