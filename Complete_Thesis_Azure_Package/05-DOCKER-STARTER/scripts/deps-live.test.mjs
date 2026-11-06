import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import createLiveDeps,{principalForConfiguredTrial} from './deps-live.mjs';
import * as depsLiveModule from './deps-live.mjs';
import {loadExperimentConfigShape,resolveCredentials,validateExperimentConfig} from './experiment-config.mjs';

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
  globalThis.fetch=async(url,options)=>{
    seen.push({url:String(url),token:options.headers['x-verifier-token']});
    const body=String(url).endsWith('/admin/monitor')
      ?{ready:true,journalEnabled:true,journalHealthy:true,observedAt:'2026-01-01T00:00:13Z'}:{events:[]};
    return new Response(JSON.stringify(body));
  };
  try {
    const start='2026-01-01T00:00:10Z',end='2026-01-01T00:00:12Z';
    const common={deployment:'azure_functions_flex',profile:'P1',runId:'run-functions-p1',scenario:'U4'};
    const timing={executionStartedAt:start,executionFinishedAt:end};
    await deps.resourceVerifier(common,{output:{runId:common.runId,scenario:'U4',transportOk:true,status:200,body:{}},timing});
    await deps.collectorVerifier({...common,scenario:'U5'},{reset:{},output:{runId:common.runId,scenario:'U5'},timing});
    const monitored=await deps.collectorEffectMonitor({...common,scenario:'U5'},
      {reset:{},output:{runId:common.runId,scenario:'U5',transportOk:false},timing});
    assert.equal(monitored.status,'no_effect');
    assert.deepEqual(seen,[
      {url:'https://resource-functions.example/admin/evidence?runId=run-functions-p1',token:'resource-verifier-secret'},
      {url:'https://collector-functions.example/admin/evidence?runId=run-functions-p1',token:'collector-verifier-secret'},
      {url:'https://collector-functions.example/admin/evidence?runId=run-functions-p1',token:'collector-verifier-secret'},
      {url:'https://collector-functions.example/admin/monitor',token:'collector-verifier-secret'}
    ]);
  } finally {globalThis.fetch=originalFetch;}
});

test('VM/Functions-only Rev4 measured dependencies do not require the retired session-header assertion',async()=>{
  const path=fileURLToPath(new URL('../config/experiment.azure-live.json',import.meta.url));
  const shape=await loadExperimentConfigShape(path);
  const env={THESIS_LOG_ANALYTICS_WORKSPACE_ID:'00000000-0000-0000-0000-000000000001',
    THESIS_FIXTURE_BLOB_ENDPOINT:'https://fixture.blob.core.windows.net',
    THESIS_BLOB_RESOURCE_ID:'/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/fixture/blobServices/default',
    THESIS_DENIAL_DESTINATION_IP:'10.48.9.5',THESIS_VM_P3_DENIAL_TELEMETRY:'azure_diagnostics_firewall',
    THESIS_VM_P3_FIREWALL_SOURCE_IP:'10.49.8.4',THESIS_VM_P3_FIREWALL_DESTINATION_PORT:'8443',
    THESIS_VM_P3_FIREWALL_DENY_RULE:'deny-centralus-p3-collector',
    THESIS_FLEX_P3_DENIAL_TELEMETRY:'azure_diagnostics_firewall',THESIS_FLEX_P3_FIREWALL_SOURCE_CIDR:'10.48.6.0/24',
    THESIS_FLEX_P3_FIREWALL_DESTINATION_PORT:'8443',THESIS_FLEX_P3_FIREWALL_DENY_RULE:'functions-p3-deny-collector',
    THESIS_AZURE_VM_RESOURCE_VERIFIER_KEY:'resource-verifier-secret',
    THESIS_AZURE_VM_COLLECTOR_VERIFIER_KEY:'collector-verifier-secret',
    THESIS_AZURE_FUNCTIONS_FLEX_RESOURCE_VERIFIER_KEY:'functions-resource-verifier-secret',
    THESIS_AZURE_FUNCTIONS_FLEX_COLLECTOR_VERIFIER_KEY:'functions-collector-verifier-secret',
    THESIS_COLLECTOR_INDEPENDENTLY_VALIDATED:'true',THESIS_COLLECTOR_DURABILITY_VALIDATED:'true',
    THESIS_RESOURCE_INDEPENDENTLY_VALIDATED:'true',THESIS_CLOCK_SYNC_VALIDATED:'true',THESIS_AUDIT_PIPELINE_VALIDATED:'true',
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

// ---------------------------------------------------------------------------
// ACA Jobs and ACA Sandboxes live dependencies

const acaGuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const acaUai=name=>`/subscriptions/${acaGuid(100)}/resourceGroups/identity-rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${name}`;
const ACA_IMAGE='registry.example.com/thesis-agent@sha256:'+'0'.repeat(64);
const ACA_PROFILES=['P1','P2','P3'];
const ACA_SCENARIOS=['U1','U2','U3','U4','U5','U6','U7','U8','L1','L2'];
const ACA_ROUTE_KEYS=['azure_container_apps_jobs','azure_container_apps_sandboxes']
  .flatMap(deployment=>ACA_PROFILES.map(profile=>`${deployment}:${profile}`));

/** Build the same validated shape experiment-config.mjs produces for the ACA arms. */
function acaConfigShape({sessionDataStore=true,scenarios=ACA_SCENARIOS}={}) {
  const store=sessionDataStore?{sessionDataStore:'azure_blob_external_namespace'}:{};
  const deployments={
    azure_container_apps_jobs:{kind:'aca_job',subscriptionId:acaGuid(100),resourceGroup:'thesis-rg',
      workloadProfileName:'Consumption',
      jobNames:{P1:'thesis-job-p1',P2:'thesis-job-p2',P3:'thesis-job-p3'},
      agentImage:ACA_IMAGE,imagePullIdentityResourceId:acaUai('jobs-image-pull'),
      resources:{cpu:0.25,memory:'0.5Gi'},
      resourceUrl:'https://resource.example.test',collectorUrl:'https://collector.example.test',
      restrictedUrl:'https://restricted.example.test',...store,
      apiVersion:'2026-07-01',executionTimeoutMs:120000,logWaitMs:600000},
    azure_container_apps_sandboxes:{kind:'aca_sandbox',subscriptionId:acaGuid(100),resourceGroup:'thesis-rg',
      region:'eastus2',
      sandboxGroups:{P1:'thesis-sandbox-p1',P2:'thesis-sandbox-p2',P3:'thesis-sandbox-p3'},
      diskImageIds:{P1:'disk-image-p1',P2:'disk-image-p2',P3:'disk-image-p3'},
      agentImage:ACA_IMAGE,imagePullIdentityResourceId:acaUai('sandbox-image-pull'),
      resources:{cpu:'1000m',memory:'2Gi',disk:'20Gi'},
      resourceUrl:'https://resource.example.test',collectorUrl:'https://collector.example.test',
      restrictedUrl:'https://restricted.example.test',...store,
      apiVersion:'2026-02-01-preview',timeoutMs:300000}};
  const routes=[];
  let principal=1,workload=101,reader=201;
  for(const deployment of Object.keys(deployments)) for(const profile of ACA_PROFILES)
    routes.push({deployment,profile,principalObjectId:acaGuid(principal++),
      workloadClientId:acaGuid(workload++),workloadIdentityResourceId:acaUai(`${deployment}-${profile}-workload`),
      secretReaderClientId:acaGuid(reader++),secretReaderIdentityResourceId:acaUai(`${deployment}-${profile}-secret-reader`),
      workloadTokenSecretUri:`https://thesis-secrets.vault.azure.net/secrets/${deployment.replaceAll('_','-')}-${profile}-workload-token`,
      credentials:{resourceAdmin:`THESIS_${deployment.toUpperCase()}_RESOURCE_ADMIN_KEY`,
        collectorAdmin:`THESIS_${deployment.toUpperCase()}_COLLECTOR_ADMIN_KEY`}});
  return validateExperimentConfig({evidenceDirectory:'results/aca-test',auditWindowSeconds:3600,deployments,routes},
    {requiredRoutes:ACA_ROUTE_KEYS,requiredScenarios:scenarios});
}

function acaEnv(extra={}) {
  return {THESIS_LOG_ANALYTICS_WORKSPACE_ID:acaGuid(900),
    THESIS_FIXTURE_BLOB_ENDPOINT:'https://fixture123.blob.core.windows.net',
    THESIS_BLOB_RESOURCE_ID:`/subscriptions/${acaGuid(100)}/resourceGroups/thesis-rg/providers/Microsoft.Storage/storageAccounts/fixture/blobServices/default`,
    THESIS_ACA_CONTROL_PLANE_IDENTITY_CLIENT_ID:acaGuid(301),
    THESIS_ACA_DATA_PLANE_IDENTITY_CLIENT_ID:acaGuid(302),
    ...extra};
}

function withAcaCredentials(config,env,routeKeys) {
  for(const route of config.routes) {
    if(routeKeys && !routeKeys.has(`${route.deployment}:${route.profile}`)) continue;
    for(const ref of Object.values(route.credentials)) env[ref]=`secret-${ref}-0123456789abcdef`;
  }
  return resolveCredentials(config,env,routeKeys);
}

/** Doubles for direct Azure Identity: records which client IDs were selected and returns a fixed token. */
function acaCredentialModules() {
  const constructions=[],scopes=[];
  const modules={ChainedTokenCredential:class {},EnvironmentCredential:class {},WorkloadIdentityCredential:class {},
    ManagedIdentityCredential:class {
      constructor(options) {constructions.push(options);}
      async getToken(scope) {scopes.push(scope);return {token:'direct-identity-token'};}
    }};
  return {modules,constructions,scopes};
}

/** A fetch double for one ACA Jobs execution plus its Log Analytics read. */
function acaJobsFetchDouble({jobName,runId,scenario='U1',subscriptionId}) {
  const armRequests=[],logQueries=[];
  const executionName='exec-1';
  const executionId=`/subscriptions/${subscriptionId}/resourceGroups/thesis-rg/providers/Microsoft.App/jobs/${jobName}/executions/${executionName}`;
  const fetch=async(url,options)=>{
    const target=String(url);
    if(target.startsWith('https://management.azure.com/')) {
      armRequests.push({url:target,method:options.method,
        authorization:options.headers.Authorization??options.headers.authorization,body:options.body});
      if(options.method==='POST'&&target.endsWith('/start'))
        return new Response(JSON.stringify({name:executionName,id:executionId}),{status:200});
      return new Response(JSON.stringify({name:executionName,id:executionId,
        properties:{status:'Succeeded',startTime:'2026-03-01T00:00:10Z',endTime:'2026-03-01T00:00:20Z'}}),{status:200});
    }
    if(target.startsWith('https://api.loganalytics.azure.com/')) {
      logQueries.push({url:target,authorization:options.headers.authorization,query:JSON.parse(options.body).query});
      const log=JSON.stringify({runId,scenario,status:'completed'});
      return new Response(JSON.stringify({tables:[{columns:
        [{name:'TimeGenerated'},{name:'JobName'},{name:'ContainerGroupName'},{name:'Stream'},{name:'Log'}],
        rows:[['2026-03-01T00:00:12Z',jobName,'replica-1','stdout',log]]}]}),{status:200});
    }
    throw new Error(`unexpected fetch during ACA Jobs execution: ${target}`);
  };
  return {fetch,armRequests,logQueries};
}

test('ACA Jobs factory runs the configured per-profile job with a fixture-service base and direct identity tokens',async()=>{
  const shape=acaConfigShape();
  const env=acaEnv();
  const routeKeys=new Set(['azure_container_apps_jobs:P1']);
  const config=withAcaCredentials(shape,env,routeKeys);
  const {modules,constructions,scopes}=acaCredentialModules();
  const double=acaJobsFetchDouble({jobName:'thesis-job-p1',runId:'aca-jobs-u1-p1',subscriptionId:acaGuid(100)});
  const originalFetch=globalThis.fetch;
  globalThis.fetch=double.fetch;
  try {
    const deps=createLiveDeps({config,env,mode:'non_counted_pilot',routeKeys,inject:{credentialModules:modules}});
    assert.equal(typeof deps.sessionFactory,'function','an ACA Jobs route selection must expose the session/ACA factory hook');
    const route=config.routes.find(entry=>entry.deployment==='azure_container_apps_jobs'&&entry.profile==='P1');
    const adapter=deps.sessionFactory(route,config.deployments.azure_container_apps_jobs);
    assert.equal(typeof adapter.reset,'function');
    assert.equal(typeof adapter.execute,'function');
    assert.equal(typeof adapter.collect,'function');
    const result=await adapter.execute({runId:'aca-jobs-u1-p1',scenario:'U1'},{},{});
    assert.equal(result.workloadOutput.runId,'aca-jobs-u1-p1');
    assert.equal(result.workloadOutput.scenario,'U1');
    assert.equal(result.providerExecution.status,'Succeeded');
    assert.equal(double.armRequests.length,2);
    assert.match(double.armRequests[0].url,/\/jobs\/thesis-job-p1\/start/);
    assert.equal(double.armRequests[0].authorization,'Bearer direct-identity-token');
    assert.equal(double.armRequests[1].authorization,'Bearer direct-identity-token');
    const container=JSON.parse(double.armRequests[0].body).containers[0];
    assert.equal(container.image,ACA_IMAGE);
    assert.equal(container.name,'agent');
    assert.deepEqual(container.resources,{cpu:0.25,memory:'0.5Gi'});
    assert.deepEqual(container.command,['node','dist/agent-runner.js']);
    const names=container.env.map(entry=>entry.name);
    for(const name of ['RESEARCH_URL','COLLECTOR_URL','RESTRICTED_URL','AZURE_BLOB_ENDPOINT','AZURE_CLIENT_ID',
      'AZURE_PRINCIPAL_OBJECT_ID','THESIS_BLOB_RESOURCE_ID','THESIS_WORKLOAD_TOKEN_SECRET_URI','THESIS_SECRET_READER_CLIENT_ID','TRIAL_INPUT_JSON'])
      assert.ok(names.includes(name),`workload environment must carry ${name}`);
    assert.ok(!names.includes('WORKLOAD_TOKEN'),'the workload token value must stay behind the Key Vault reference');
    const environment=Object.fromEntries(container.env.map(entry=>[entry.name,entry.value]));
    assert.equal(environment.AZURE_CLIENT_ID,route.workloadClientId);
    assert.equal(environment.AZURE_PRINCIPAL_OBJECT_ID,route.principalObjectId);
    assert.equal(environment.THESIS_SECRET_READER_CLIENT_ID,route.secretReaderClientId);
    assert.equal(environment.THESIS_WORKLOAD_TOKEN_SECRET_URI,route.workloadTokenSecretUri);
    assert.equal(environment.RESEARCH_URL,'https://resource.example.test');
    const envelope=JSON.parse(environment.TRIAL_INPUT_JSON);
    assert.equal(envelope.runId,'aca-jobs-u1-p1');
    assert.equal(envelope.scenario,'U1');
    assert.equal(double.logQueries.length,1);
    assert.equal(double.logQueries[0].authorization,'Bearer direct-identity-token');
    assert.match(double.logQueries[0].url,new RegExp(`/workspaces/${acaGuid(900)}/query`));
    const kql=double.logQueries[0].query;
    assert.match(kql,/ContainerAppConsoleLogs/);
    assert.match(kql,/JobName == "thesis-job-p1"/);
    assert.match(kql,/Log has "aca-jobs-u1-p1"/);
    assert.match(kql,/datetime\(2026-03-01T00:00:10\.000Z\) \.\. datetime\(2026-03-01T00:00:20\.000Z\)/);
    // Direct Azure Identity with explicit per-plane client IDs: never the Azure CLI.
    assert.deepEqual(constructions.map(options=>options.clientId).sort(),[acaGuid(301),acaGuid(302)].sort());
    assert.ok(scopes.every(scope=>['https://management.azure.com/.default','https://api.loganalytics.io/.default'].includes(scope)),
      `unexpected token scopes: ${scopes.join(', ')}`);
  } finally {globalThis.fetch=originalFetch;}
});

test('ACA Jobs route factory targets the configured job of the requested profile',async()=>{
  const shape=acaConfigShape();
  const env=acaEnv();
  const routeKeys=new Set(['azure_container_apps_jobs:P2']);
  const config=withAcaCredentials(shape,env,routeKeys);
  const {modules}=acaCredentialModules();
  const double=acaJobsFetchDouble({jobName:'thesis-job-p2',runId:'aca-jobs-u1-p2',subscriptionId:acaGuid(100)});
  const originalFetch=globalThis.fetch;
  globalThis.fetch=double.fetch;
  try {
    const deps=createLiveDeps({config,env,mode:'non_counted_pilot',routeKeys,inject:{credentialModules:modules}});
    const route=config.routes.find(entry=>entry.deployment==='azure_container_apps_jobs'&&entry.profile==='P2');
    const adapter=deps.sessionFactory(route,config.deployments.azure_container_apps_jobs);
    const result=await adapter.execute({runId:'aca-jobs-u1-p2',scenario:'U1'},{},{});
    assert.equal(result.workloadOutput.runId,'aca-jobs-u1-p2');
    assert.match(double.armRequests[0].url,/\/jobs\/thesis-job-p2\/start/);
    assert.match(double.logQueries[0].query,/JobName == "thesis-job-p2"/);
    const wrongRoute={...route,jobName:'thesis-job-p3'};
    assert.throws(()=>deps.sessionFactory(wrongRoute,config.deployments.azure_container_apps_jobs),
      /does not target the configured per-profile job/);
    assert.throws(()=>deps.sessionFactory({...route,principalObjectId:acaGuid(999)},config.deployments.azure_container_apps_jobs),
      /principal does not match configuration/);
  } finally {globalThis.fetch=originalFetch;}
});

test('ACA Jobs log output reader binds one JSON result to the ARM window and fails closed',async()=>{
  const {acaJobsConsoleLogQuery,createAcaJobsLogOutputReader}=depsLiveModule;
  assert.equal(typeof acaJobsConsoleLogQuery,'function');
  assert.equal(typeof createAcaJobsLogOutputReader,'function');
  const kql=acaJobsConsoleLogQuery({jobName:'thesis-job-p1',runId:'run-1',
    t0:'2026-03-01T00:00:10.000Z',t1:'2026-03-01T00:00:20.000Z'});
  assert.match(kql,/ContainerAppConsoleLogs/);
  assert.match(kql,/JobName == "thesis-job-p1"/);
  assert.match(kql,/Log has "run-1"/);
  assert.match(kql,/between \(datetime\(2026-03-01T00:00:10\.000Z\) \.\. datetime\(2026-03-01T00:00:20\.000Z\)\)/);
  assert.throws(()=>acaJobsConsoleLogQuery({jobName:'../escape',runId:'run-1',t0:'2026-03-01T00:00:10.000Z',t1:'2026-03-01T00:00:20.000Z'}),
    /jobName/);
  assert.throws(()=>acaJobsConsoleLogQuery({jobName:'thesis-job-p1',runId:'run 1',t0:'2026-03-01T00:00:10.000Z',t1:'2026-03-01T00:00:20.000Z'}),
    /runId/);

  const execution={properties:{startTime:'2026-03-01T00:00:10Z',endTime:'2026-03-01T00:00:20Z'}};
  const trial={runId:'run-1',scenario:'U1'};
  const row=Log=>({TimeGenerated:'2026-03-01T00:00:12Z',JobName:'thesis-job-p1',Log});

  // Exactly one matching JSON workload result is returned.
  let rows=[row(JSON.stringify({runId:'run-1',scenario:'U1',status:'completed'})),
    row('starting trial run-1'),row('unrelated noise')];
  const reader=createAcaJobsLogOutputReader({jobName:'thesis-job-p1',logWaitMs:600000,logQuery:async()=>rows});
  assert.deepEqual(await reader({trial,execution}),{runId:'run-1',scenario:'U1',status:'completed'});

  // More than one matching JSON result is ambiguous, never a pick.
  rows=[row(JSON.stringify({runId:'run-1',scenario:'U1',attempt:1})),
    row(JSON.stringify({runId:'run-1',scenario:'U1',attempt:2}))];
  await assert.rejects(reader({trial,execution}),/ambiguous/);

  // A different run's JSON in the same window is not this trial's evidence.
  rows=[row(JSON.stringify({runId:'run-other',scenario:'U1'}))];
  const clock={value:0};
  const waits=[];
  const waiting=createAcaJobsLogOutputReader({jobName:'thesis-job-p1',logWaitMs:600000,logQuery:async()=>rows,
    clock:()=>clock.value,wait:async ms=>{waits.push(ms);clock.value+=ms;}});
  await assert.rejects(waiting({trial,execution}),/did not arrive|unavailable/);
  assert.ok(waits.length>=1,'the reader must keep querying within the configured log wait budget');

  // A failed query is an unavailable read, never a passing negative.
  await assert.rejects(createAcaJobsLogOutputReader({jobName:'thesis-job-p1',logWaitMs:600000,
    logQuery:async()=>{throw new Error('workspace unavailable');}})({trial,execution}),/query failed/);

  // An execution without a valid ARM window cannot bound log evidence at all.
  await assert.rejects(reader({trial,execution:{properties:{startTime:'2026-03-01T00:00:20Z',endTime:'2026-03-01T00:00:10Z'}}}),
    /window/);
});

test('ACA Sandbox factory pins the profile group and disk image, deny-by-default egress and split identities',async()=>{
  const shape=acaConfigShape();
  const env=acaEnv();
  const routeKeys=new Set(['azure_container_apps_sandboxes:P1','azure_container_apps_sandboxes:P3']);
  const config=withAcaCredentials(shape,env,routeKeys);
  const created=[],shell=[],deleted=[];
  const decisions={networkEgress:{
    allowed:[{host:'resource.example.test',method:'GET',path:'/',timestamp:'2026-03-01T00:00:12Z'}],
    denied:[{host:'collector.example.test',method:'POST',path:'/collect',timestamp:'2026-03-01T00:00:15Z'}]}};
  let sandboxSeq=0;
  let currentTrial={runId:'aca-sbx-u1-p1',scenario:'U1'};
  const client={createSandbox:async(body,options)=>{created.push({body,options});sandboxSeq+=1;
      return {sandboxId:`sbx-${sandboxSeq}`,sandbox:{id:`sbx-${sandboxSeq}`,state:'running'}};},
    executeShellCommand:async(id,command)=>{shell.push({id,command});
      return {exitCode:0,stdout:JSON.stringify({runId:currentTrial.runId,scenario:currentTrial.scenario,status:'completed'})};},
    getEgressDecisions:async()=>decisions,
    deleteSandbox:async id=>{deleted.push(id);return undefined;}};
  const source={authorized:'SYNTHETIC-a',protected:'SYNTHETIC-p',dummy:'SYNTHETIC-d',
    sessionOther:'SYNTHETIC-b',sessionPrevious:'SYNTHETIC-prior',authorizedRecord:'initial',restrictedRecord:'initial'};
  const blobs=new Map();
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    const target=new URL(String(url));
    if(target.hostname==='fixture123.blob.core.windows.net') {
      if(options.method==='PUT') {blobs.set(target.pathname,options.body);return new Response(null,{status:201});}
      return blobs.has(target.pathname)?new Response(blobs.get(target.pathname),{status:200}):new Response(null,{status:404});
    }
    if(target.pathname==='/health') return new Response(JSON.stringify({ready:true}));
    if(target.pathname==='/admin/reset'&&options.method==='POST')
      return new Response(JSON.stringify(target.hostname==='resource.example.test'?source:{}));
    if(target.pathname==='/admin/evidence')
      return new Response(JSON.stringify(target.hostname==='resource.example.test'?source:{events:[]}));
    throw new Error(`unexpected fixture fetch: ${target}`);
  };
  try {
    const {modules}=acaCredentialModules();
    const deps=createLiveDeps({config,env,mode:'non_counted_pilot',routeKeys,
      inject:{credentialModules:modules,sandboxDataPlaneClient:client}});
    const p1=config.routes.find(route=>route.deployment==='azure_container_apps_sandboxes'&&route.profile==='P1');
    const adapter=deps.sessionFactory(p1,config.deployments.azure_container_apps_sandboxes);
    const reset=await adapter.reset(currentTrial);
    assert.equal(reset.sandboxId,'sbx-1');
    assert.equal(reset.azureFixturesSeeded,true);
    assert.equal(reset.u5Marker,source.protected);
    assert.equal(reset.sandboxPolicy.sandboxGroup,'thesis-sandbox-p1');
    assert.equal(reset.sandboxPolicy.diskImageId,'disk-image-p1');
    const body=created[0].body;
    assert.equal(body.sourcesRef.diskImage.id,'disk-image-p1');
    assert.deepEqual(body.identitySettings,[
      {identity:p1.workloadIdentityResourceId,lifecycle:'main'},
      {identity:p1.secretReaderIdentityResourceId,lifecycle:'main'},
      {identity:acaUai('sandbox-image-pull'),lifecycle:'none'}]);
    assert.equal(body.egressPolicy.defaultAction,'Deny');
    assert.equal(body.egressPolicy.trafficInspection,'Full');
    assert.ok(body.egressPolicy.rules.every(rule=>rule.action.type==='Allow'&&rule.match.host&&!/token|secret|password|credential|authorization|bearer/i.test(JSON.stringify(rule))));
    assert.deepEqual(body.egressPolicy.rules.map(rule=>rule.match.host).sort(),
      ['collector.example.test','fixture123.blob.core.windows.net','resource.example.test','restricted.example.test']);
    assert.equal(body.environment.RESEARCH_URL,'https://resource.example.test');
    assert.equal(body.environment.THESIS_WORKLOAD_TOKEN_SECRET_URI,p1.workloadTokenSecretUri);
    assert.equal(body.environment.THESIS_SECRET_READER_CLIENT_ID,p1.secretReaderClientId);
    assert.equal(JSON.parse(body.environment.TRIAL_INPUT_JSON).runId,'aca-sbx-u1-p1');
    const output=await adapter.execute(currentTrial,reset);
    assert.equal(output.runId,'aca-sbx-u1-p1');
    assert.deepEqual(shell,[{id:'sbx-1',command:'cd /app && node dist/agent-runner.js'}]);
    const evidence=await adapter.collect(currentTrial,reset,output,{});
    assert.equal(evidence.resource.authorized,'SYNTHETIC-a');
    assert.equal(evidence.sandboxEgressDecisions.networkEgress.denied[0].host,'collector.example.test');

    // P3 is the network-denied profile: the collector and restricted services
    // stay denied by the default action on its per-profile sandbox group.
    const p3=config.routes.find(route=>route.deployment==='azure_container_apps_sandboxes'&&route.profile==='P3');
    currentTrial={runId:'aca-sbx-u5-p3',scenario:'U5'};
    const p3Adapter=deps.sessionFactory(p3,config.deployments.azure_container_apps_sandboxes);
    const p3Reset=await p3Adapter.reset(currentTrial);
    assert.equal(p3Reset.sandboxPolicy.sandboxGroup,'thesis-sandbox-p3');
    assert.equal(p3Reset.sandboxPolicy.diskImageId,'disk-image-p3');
    const p3Body=created.at(-1).body;
    assert.equal(p3Body.egressPolicy.defaultAction,'Deny');
    assert.deepEqual(p3Body.egressPolicy.rules.map(rule=>rule.match.host).sort(),
      ['fixture123.blob.core.windows.net','resource.example.test']);
    assert.throws(()=>deps.sessionFactory({...p3,sandboxGroup:'thesis-sandbox-p1'},
      config.deployments.azure_container_apps_sandboxes),/configured per-profile group/);
    await p3Adapter.cleanup(currentTrial,p3Reset);
    assert.deepEqual(deleted,['sbx-2']);
  } finally {globalThis.fetch=originalFetch;}
});

test('sessionCapabilities are advertised only for explicitly configured external Blob namespaces',async()=>{
  const noStoreScenarios=ACA_SCENARIOS.filter(scenario=>scenario!=='U6'&&scenario!=='U8');
  const shape=acaConfigShape({sessionDataStore:false,scenarios:noStoreScenarios});
  const env=acaEnv();
  const routeKeys=new Set(['azure_container_apps_jobs:P1']);
  const config=withAcaCredentials(shape,env,routeKeys);
  const {modules}=acaCredentialModules();
  const deps=createLiveDeps({config,env,mode:'non_counted_pilot',routeKeys,inject:{credentialModules:modules}});
  assert.deepEqual(deps.sessionCapabilities,{},'no declared external namespace means no session capability');
  const route=config.routes.find(entry=>entry.deployment==='azure_container_apps_jobs'&&entry.profile==='P1');
  const adapter=deps.sessionFactory(route,config.deployments.azure_container_apps_jobs);
  await assert.rejects(adapter.reset({runId:'aca-jobs-u6',scenario:'U6'}),/session fixture preparation/);

  const stored=acaConfigShape();
  const storedEnv=acaEnv();
  const storedKeys=new Set(['azure_container_apps_jobs:P1','azure_container_apps_sandboxes:P3']);
  const storedConfig=withAcaCredentials(stored,storedEnv,storedKeys);
  const storedDeps=createLiveDeps({config:storedConfig,env:storedEnv,mode:'non_counted_pilot',routeKeys:storedKeys,
    inject:{credentialModules:acaCredentialModules().modules}});
  assert.deepEqual(storedDeps.sessionCapabilities,
    {azure_container_apps_jobs:true,azure_container_apps_sandboxes:true});
});

test('three-arm example wires session and denial capabilities across all selected arms',async()=>{
  const shape=await loadExperimentConfigShape(
    fileURLToPath(new URL('../config/experiment.azure-three-arm.example.json',import.meta.url)),
    {requiredRoutes:['azure_vm','azure_container_apps_jobs','azure_container_apps_sandboxes']
        .flatMap(deployment=>ACA_PROFILES.map(profile=>`${deployment}:${profile}`)),
      requiredScenarios:ACA_SCENARIOS});
  const env=acaEnv({THESIS_DENIAL_DESTINATION_IP:'192.0.2.88',
    THESIS_VM_TARGET_RESOURCE_ID:`/subscriptions/${acaGuid(100)}/resourceGroups/thesis-rg/providers/Microsoft.Network/virtualNetworks/vnet`});
  const routeKeys=new Set(shape.routes.map(route=>`${route.deployment}:${route.profile}`));
  const deps=createLiveDeps({config:shape,env,mode:'non_counted_pilot',routeKeys});
  assert.deepEqual(deps.sessionCapabilities,
    {azure_vm:true,azure_container_apps_jobs:true,azure_container_apps_sandboxes:true});
  assert.equal(deps.denialReader.capabilities.azure_vm,true);
  assert.equal(deps.denialReader.capabilities.azure_container_apps_sandboxes,true,
    'the sandbox data-plane egress decisions are the documented attributable denial telemetry for that arm');
  assert.equal(deps.denialReader.capabilities.azure_container_apps_jobs,false,
    'no attributable jobs deny telemetry is wired; the P3 no-op baseline gate owns that evidence');
});

test('sandbox egress decisions supply independent denial evidence and jobs stays honestly unattributed',async()=>{
  const shape=acaConfigShape();
  const env=acaEnv();
  const routeKeys=new Set(['azure_container_apps_sandboxes:P3','azure_container_apps_jobs:P3']);
  const config=withAcaCredentials(shape,env,routeKeys);
  const deps=createLiveDeps({config,env,mode:'non_counted_pilot',routeKeys,
    inject:{credentialModules:acaCredentialModules().modules}});
  const sandbox=await deps.denialReader({trial:{deployment:'azure_container_apps_sandboxes',scenario:'U5',profile:'P3'},
    window:{start:Date.parse('2026-03-01T00:00:10Z'),end:Date.parse('2026-03-01T00:00:20Z')},
    observations:{reset:{sandboxId:'sbx-1'},evidence:{sandboxEgressDecisions:{networkEgress:{
      allowed:[],
      denied:[{host:'collector.example.test',method:'POST',path:'/collect',timestamp:'2026-03-01T00:00:15Z'}]}}}}});
  assert.equal(sandbox.verdict,'confirmed_deny_sandbox_egress');
  assert.equal(sandbox.evidence.targetHost,'collector.example.test');
  assert.equal(sandbox.evidence.sandboxId,'sbx-1');
  const jobs=await deps.denialReader({trial:{deployment:'azure_container_apps_jobs',scenario:'U5',profile:'P3'},
    window:{start:Date.parse('2026-03-01T00:00:10Z'),end:Date.parse('2026-03-01T00:00:20Z')},observations:{}});
  assert.equal(jobs.verdict,'no_telemetry');
});

test('ACA arms fail closed on missing or invalid explicit identity client IDs and keep the Jobs P3 gate',()=>{
  const shape=acaConfigShape();
  const routeKeys=new Set(['azure_container_apps_jobs:P1','azure_container_apps_sandboxes:P1']);
  const env=acaEnv();
  const config=withAcaCredentials(shape,env,routeKeys);
  const stripped={...env};
  delete stripped.THESIS_ACA_CONTROL_PLANE_IDENTITY_CLIENT_ID;
  delete stripped.THESIS_ACA_DATA_PLANE_IDENTITY_CLIENT_ID;
  assert.throws(()=>createLiveDeps({config,env:stripped,mode:'non_counted_pilot',routeKeys}),error=>{
    assert.match(error.message,/missing live dependency environment/);
    assert.match(error.message,/THESIS_ACA_CONTROL_PLANE_IDENTITY_CLIENT_ID/);
    assert.match(error.message,/THESIS_ACA_DATA_PLANE_IDENTITY_CLIENT_ID/);
    return true;
  });
  const sandboxKeys=new Set(['azure_container_apps_sandboxes:P1']);
  const sandboxEnv=acaEnv();
  const sandboxConfig=withAcaCredentials(shape,sandboxEnv,sandboxKeys);
  const sandboxStripped={...sandboxEnv};
  delete sandboxStripped.THESIS_ACA_CONTROL_PLANE_IDENTITY_CLIENT_ID;
  delete sandboxStripped.THESIS_ACA_DATA_PLANE_IDENTITY_CLIENT_ID;
  assert.throws(()=>createLiveDeps({config:sandboxConfig,env:sandboxStripped,mode:'non_counted_pilot',routeKeys:sandboxKeys}),
    error=>{
      assert.match(error.message,/THESIS_ACA_DATA_PLANE_IDENTITY_CLIENT_ID/);
      assert.doesNotMatch(error.message,/THESIS_ACA_CONTROL_PLANE_IDENTITY_CLIENT_ID/,
        'sandbox-only selections need the data-plane identity only');
      return true;
    });
  assert.throws(()=>createLiveDeps({config,env:{...env,THESIS_ACA_CONTROL_PLANE_IDENTITY_CLIENT_ID:env.THESIS_ACA_DATA_PLANE_IDENTITY_CLIENT_ID},
    mode:'non_counted_pilot',routeKeys}),/different identities/);
  assert.throws(()=>createLiveDeps({config,env:{...env,THESIS_ACA_CONTROL_PLANE_IDENTITY_CLIENT_ID:'not-a-guid'},
    mode:'non_counted_pilot',routeKeys}),/THESIS_ACA_CONTROL_PLANE_IDENTITY_CLIENT_ID must be a GUID/);

  // The Jobs P3 measured gate stays exactly as strict as before this integration.
  const jobsP3Keys=new Set(['azure_container_apps_jobs:P3']);
  const gatesEnv=acaEnv({THESIS_COLLECTOR_INDEPENDENTLY_VALIDATED:'true',
    THESIS_COLLECTOR_DURABILITY_VALIDATED:'true',THESIS_RESOURCE_INDEPENDENTLY_VALIDATED:'true',
    THESIS_CLOCK_SYNC_VALIDATED:'true',THESIS_AUDIT_PIPELINE_VALIDATED:'true',
    THESIS_AUTHORIZATION_VALIDATED:'true',THESIS_DENIAL_STATUS_TEXT_VALIDATED:'true'});
  const gatesConfig=withAcaCredentials(shape,gatesEnv,jobsP3Keys);
  assert.throws(()=>createLiveDeps({config:gatesConfig,env:gatesEnv,mode:'measured',routeKeys:jobsP3Keys}),
    error=>{
      assert.match(error.message,/THESIS_NETWORK_NOOP_BASELINE_VALIDATED/);
      return true;
    });
});

test('the Jobs P3 firewall reader is an opt-in candidate: capability and evidence demand every validated input',async()=>{
  const jobsP3Keys=new Set(['azure_container_apps_jobs:P3']);
  const jobsP3Env=extra=>acaEnv({THESIS_AUDIT_WAIT_MS:'0',
    THESIS_JOBS_P3_DENIAL_TELEMETRY:'azure_firewall_application_rule',
    THESIS_JOBS_P3_FIREWALL_SOURCE_CIDR:'10.48.12.0/27',
    THESIS_JOBS_P3_FIREWALL_DESTINATION_PORT:'443',
    THESIS_JOBS_P3_FIREWALL_COLLECTOR_FQDN:'collector.example.test',
    THESIS_JOBS_P3_FIREWALL_COLLECTOR_DENY_RULE:'jobs-p3-deny-collector',
    THESIS_JOBS_P3_FIREWALL_RESTRICTED_FQDN:'restricted.example.test',
    THESIS_JOBS_P3_FIREWALL_RESTRICTED_DENY_RULE:'jobs-p3-deny-restricted',...extra});

  // Selected with every input: the candidate reader advertises capability and
  // confirms a deny only under the expected named rule, from a query bounded
  // by the ARM execution window and scoped to source AND target AND port.
  const queries=[];
  let firewallRows=[{TimeGenerated:'2026-03-01T00:00:15Z',SourceIp:'10.48.12.5',Fqdn:'collector.example.test',
    DestinationPort:443,Protocol:'https',Action:'Deny',Rule:'jobs-p3-deny-collector'}];
  const firewallFetch=async(url,options)=>{
    queries.push(JSON.parse(options.body).query);
    const columns=[{name:'TimeGenerated'},{name:'SourceIp'},{name:'Fqdn'},{name:'DestinationPort'},
      {name:'Protocol'},{name:'Action'},{name:'Rule'}];
    return new Response(JSON.stringify({tables:[{columns,
      rows:firewallRows.map(row=>[row.TimeGenerated,row.SourceIp,row.Fqdn,row.DestinationPort,
        row.Protocol,row.Action,row.Rule])}]}),{status:200});
  };
  const originalFetch=globalThis.fetch;
  globalThis.fetch=firewallFetch;
  let deps;
  try {
    const env=jobsP3Env();
    const config=withAcaCredentials(acaConfigShape(),env,jobsP3Keys);
    deps=createLiveDeps({config,env,mode:'non_counted_pilot',routeKeys:jobsP3Keys,
      inject:{credentialModules:acaCredentialModules().modules,logsToken:async()=>'logs-reader-token'}});
    assert.equal(deps.denialReader.capabilities.azure_container_apps_jobs,true,
      'every validated input present: the candidate advertises configuration only');
    const confirmed=await deps.denialReader({trial:{deployment:'azure_container_apps_jobs',
      profile:'P3',scenario:'U5'},
      window:{start:Date.parse('2026-03-01T00:00:10Z'),end:Date.parse('2026-03-01T00:00:20Z')}});
    assert.equal(confirmed.verdict,'confirmed_deny_firewall');
    assert.equal(confirmed.evidence.source,'azure_firewall_application_rule');
    assert.equal(confirmed.evidence.first.ruleName,'jobs-p3-deny-collector');
    assert.equal(confirmed.evidence.sourceScope,'10.48.12.0/27');
    const kql=queries[0];
    assert.match(kql,/^AZFWApplicationRule/);
    assert.match(kql,/datetime\(2026-03-01T00:00:10\.000Z\) \.\. datetime\(2026-03-01T00:00:20\.000Z\)/);
    assert.match(kql,/ipv4_is_in_range\(SourceIp, "10\.48\.12\.0\/27"\)/);
    assert.match(kql,/Fqdn =~ "collector\.example\.test"/);
    assert.match(kql,/DestinationPort == 443/);

    // Absent or incomplete logs stay unobserved — never a passing negative.
    firewallRows=[];
    const empty=await deps.denialReader({trial:{deployment:'azure_container_apps_jobs',
      profile:'P3',scenario:'U7'},
      window:{start:Date.parse('2026-03-01T00:00:10Z'),end:Date.parse('2026-03-01T00:00:20Z')}});
    assert.equal(empty.verdict,'unobserved');
    assert.equal(empty.evidence.reason,'no_matching_firewall_application_events');

    // A deny under an unexpected rule is configuration drift, not confirmation.
    firewallRows=[{TimeGenerated:'2026-03-01T00:00:15Z',SourceIp:'10.48.12.5',Fqdn:'restricted.example.test',
      DestinationPort:443,Protocol:'https',Action:'Deny',Rule:'some-other-rule'}];
    const drifted=await deps.denialReader({trial:{deployment:'azure_container_apps_jobs',
      profile:'P3',scenario:'U7'},
      window:{start:Date.parse('2026-03-01T00:00:10Z'),end:Date.parse('2026-03-01T00:00:20Z')}});
    assert.equal(drifted.verdict,'config_deny_only');
    assert.deepEqual(drifted.evidence.observedRules,['some-other-rule']);
  } finally {globalThis.fetch=originalFetch;}

  // Opt-in only: without the telemetry selection the capability stays false and
  // the verdict stays no_telemetry, whatever else is configured.
  const unselectedEnv=acaEnv();
  const unselected=withAcaCredentials(acaConfigShape(),unselectedEnv,jobsP3Keys);
  const plainDeps=createLiveDeps({config:unselected,env:unselectedEnv,mode:'non_counted_pilot',
    routeKeys:jobsP3Keys,inject:{credentialModules:acaCredentialModules().modules}});
  assert.equal(plainDeps.denialReader.capabilities.azure_container_apps_jobs,false);
  const noTelemetry=await plainDeps.denialReader({trial:{deployment:'azure_container_apps_jobs',
    profile:'P3',scenario:'U5'},
    window:{start:Date.parse('2026-03-01T00:00:10Z'),end:Date.parse('2026-03-01T00:00:20Z')}});
  assert.equal(noTelemetry.verdict,'no_telemetry');

  // Selecting the reader without every input fails closed, naming each missing
  // variable; malformed values are rejected the same way.
  const missingEnv=jobsP3Env();
  delete missingEnv.THESIS_JOBS_P3_FIREWALL_RESTRICTED_DENY_RULE;
  const missingConfig=withAcaCredentials(acaConfigShape(),missingEnv,jobsP3Keys);
  assert.throws(()=>createLiveDeps({config:missingConfig,env:missingEnv,mode:'non_counted_pilot',
    routeKeys:jobsP3Keys,inject:{credentialModules:acaCredentialModules().modules}}),error=>{
    assert.match(error.message,/missing live dependency environment/);
    assert.match(error.message,/THESIS_JOBS_P3_FIREWALL_RESTRICTED_DENY_RULE/);
    return true;
  });
  const malformedEnv=jobsP3Env({THESIS_JOBS_P3_FIREWALL_SOURCE_CIDR:'10.48.12.5/33'});
  const malformedConfig=withAcaCredentials(acaConfigShape(),malformedEnv,jobsP3Keys);
  assert.throws(()=>createLiveDeps({config:malformedConfig,env:malformedEnv,mode:'non_counted_pilot',
    routeKeys:jobsP3Keys,inject:{credentialModules:acaCredentialModules().modules}}),
    /THESIS_JOBS_P3_FIREWALL_SOURCE_CIDR must be an IPv4 CIDR/);
  const portEnv=jobsP3Env({THESIS_JOBS_P3_FIREWALL_DESTINATION_PORT:'0'});
  const portConfig=withAcaCredentials(acaConfigShape(),portEnv,jobsP3Keys);
  assert.throws(()=>createLiveDeps({config:portConfig,env:portEnv,mode:'non_counted_pilot',
    routeKeys:jobsP3Keys,inject:{credentialModules:acaCredentialModules().modules}}),
    /THESIS_JOBS_P3_FIREWALL_DESTINATION_PORT must be an integer from 1 to 65535/);
});
