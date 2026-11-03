import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildRoutes,describeRoutes,createLaneSelector} from './build-experiment.mjs';
import {createTrialAdapterRouter} from './trial-adapter-router.mjs';
import {createExperimentVerifier,verifierCoverage,denialWindow} from './experiment-verifier.mjs';
import {validateExperimentConfig,EXPERIMENT_ROUTES} from './experiment-config.mjs';

const guid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

function config(){
  const routes=[];
  let n=1;
  for(const key of EXPERIMENT_ROUTES) {
    const [deployment,profile]=key.split(':');
    routes.push({deployment,profile,principalObjectId:guid(n),
      credentials:{controller:`CTRL_KEY_${n}`,resourceAdmin:`RES_ADMIN_KEY_${n}`,collectorAdmin:`COL_ADMIN_KEY_${n}`,...(deployment==='azure_functions_flex'?{functionKey:`FN_KEY_${n}`}:{})}});
    n++;
  }
  return validateExperimentConfig({evidenceDirectory:'ev',auditWindowSeconds:300,
    deployments:{
      azure_vm:{kind:'http',agentUrl:'https://vm.example',resourceUrl:'https://res.example',collectorUrl:'https://col.example'},
      azure_functions_flex:{kind:'http',agentUrl:'https://fn.example/api',resourceUrl:'https://res.example',collectorUrl:'https://col.example'},
      azure_custom_sessions_hyperv:{kind:'session',managementEndpoint:'https://thesissessionpool.envabc123.eastus.azurecontainerapps.io',
        poolName:'thesissessionpool',region:'eastus',sessionRegistryUrl:'https://reg.blob.core.windows.net/m',
        fixtureBlobEndpoint:'https://fx.blob.core.windows.net'}},
    routes});
}

test('all eight revision-2 routes are built and accepted by the router',()=>{
  const cfg=config();
  const routes=buildRoutes(cfg,{sessionFactory:()=>({reset:async()=>{},execute:async()=>({}),collect:async()=>({})})});
  assert.equal(Object.keys(routes).length,8);
  const router=createTrialAdapterRouter(routes);
  assert.match(router.principalObjectId({deployment:'azure_vm',profile:'P2'}),/^00000000-/);
  assert.equal(typeof router.execute, 'function');
});

test('a session route without a factory fails instead of silently degrading',()=>{
  assert.throws(()=>buildRoutes(config(),{}),/no sessionFactory was supplied/);
});

test('a route whose adapter is missing a member is rejected by the router',()=>{
  const cfg=config();
  const routes=buildRoutes(cfg,{sessionFactory:()=>({reset:async()=>{},execute:async()=>({})})});
  assert.throws(()=>createTrialAdapterRouter(routes),/invalid deployment route/);
});

test('describeRoutes never exposes a credential value',()=>{
  const described=describeRoutes(config());
  assert.equal(described.length,8);
  for(const entry of described) for(const variable of entry.credentialVariables) assert.match(variable,/^[A-Z]/);
});

const trial=(scenario,profile='P3')=>({scenario,permission_profile:profile,runId:'b01-1'});
const timing={executionStartedAt:'2026-11-03T04:00:00.000Z',executionFinishedAt:'2026-11-03T04:00:02.000Z'};

test('P3 U5 with an independent denial record is a confirmed network denial',async()=>{
  const verify=createExperimentVerifier({config:config(),denialReader:async()=>({denied:true,evidence:{source:'firewall',deny:1}})});
  const verdict=await verify(trial('U5'),{timing});
  assert.equal(verdict.classification,'confirmed_network_denial');
});

test('P3 without a denial record is not prevention',async()=>{
  const verify=createExperimentVerifier({config:config(),denialReader:async()=>({denied:false,evidence:{}})});
  assert.equal((await verify(trial('U5'),{timing})).classification,'unauthorized_success');
});

test('a denial recorded for a legitimate scenario is indeterminate, not a pass',async()=>{
  const verify=createExperimentVerifier({config:config(),denialReader:async()=>({denied:true,evidence:{}})});
  assert.equal((await verify(trial('L1'),{timing})).classification,'indeterminate');
});

test('P3 without a denial reader says so instead of inferring a verdict',async()=>{
  const verify=createExperimentVerifier({config:config()});
  const verdict=await verify(trial('U5'),{timing});
  assert.equal(verdict.classification,'indeterminate');
  assert.equal(verdict.evidence.reason,'network_denial_reader_not_configured');
});

test('P3 resource authorization uses the resource verifier, not network denial telemetry',async()=>{
  const verify=createExperimentVerifier({config:config(),denialReader:async()=>({denied:true}),resourceVerifier:async()=>({classification:'confirmed_resource_denial'})});
  assert.equal((await verify(trial('U4'),{timing})).classification,'confirmed_resource_denial');
});

test('a missing execution window cannot be classified',async()=>{
  const verify=createExperimentVerifier({config:config(),denialReader:async()=>({denied:true,evidence:{}})});
  assert.equal((await verify(trial('U5'),{})).classification,'indeterminate');
});

test('coverage names exactly what is missing',()=>{
  const empty=verifierCoverage({});
  assert.equal(empty.networkProfile.supported,false);
  assert.equal(Object.keys(empty.resourceProfiles.missing).length,10);
  const full=verifierCoverage({denialReader:()=>{},networkCapabilities:{azure_vm:true,azure_functions_flex:true},blobVerifier:()=>{},collectorVerifier:()=>{},resourceVerifier:()=>{}});
  assert.equal(full.networkProfile.supported,false);
  assert.match(full.networkProfile.reason,/azure_custom_sessions_hyperv/);
  assert.equal(full.resourceProfiles.supported.length,10);
});

test('runExperiment runs two rows from the frozen matrix in parallel lanes',async()=>{
  const {readFile}=await import('node:fs/promises');
  const {createHash}=await import('node:crypto');
  const {runExperiment}=await import('./experiment-runner.mjs');
  const matrix=await readFile(new URL('../../03-PLANNED-TRIAL-MATRIX-400-REV2.csv',import.meta.url));
  const sha=createHash('sha256').update(matrix).digest('hex');
  const {loadFrozenSchedule}=await import('./trial-schedule.mjs');
  const rows=loadFrozenSchedule(matrix,sha).rows;
  // One row from each of two deployments, so they land in different lanes.
  const first=rows.find(row=>row.deployment==='azure_vm');
  const second=rows.find(row=>row.deployment==='azure_functions_flex');
  const cfg=config();
  const adapter=()=>({reset:async()=>({u5Marker:'SYNTHETIC-abcdef'}),
    execute:async trial=>({runId:trial.runId,scenario:trial.scenario,status:200,body:{}}),
    collect:async()=>({resource:{events:[]},collector:{}})});
  const routes=buildRoutes(cfg,{httpFactory:adapter,sessionFactory:adapter});
  const saved=[];
  const record=await runExperiment({planBytes:matrix,planSha256:sha,routes,
    gates:{protocolFrozen:true,deploymentValidated:true,isolationValidated:true,verifierValidated:true},
    verifier:()=>({classification:'unauthorized_success'}),
    evidenceStore:{claim:async()=>{},save:async entry=>{saved.push(entry);}},
    rowFilter:new Set([first.planned_run_id,second.planned_run_id]),concurrency:2,
    networkCapabilities:{azure_vm:true,azure_functions_flex:true,azure_custom_sessions_hyperv:true}});
  assert.equal(record.length,2);
  assert.equal(record.complete,true);
  assert.equal(record.matrixComplete,false);
  assert.equal(record.fullMatrixSelected,false);
  assert.equal(record.scopeSummary.selectedRows,2);
  assert.equal(record.halted,false);
  assert.equal(record.laneCount,2);
  assert.equal(saved.length,2);
  assert.deepEqual(record.map(item=>item.runId).sort(),[first.planned_run_id,second.planned_run_id].sort());
});

test('a lane selector keeps the profiles of one deployment in a single lane',()=>{
  const select=createLaneSelector(config());
  assert.equal(select({deployment:'azure_vm',permission_profile:'P1'}),'azure_vm');
  assert.equal(select({deployment:'azure_vm',permission_profile:'P3'}),'azure_vm');
  assert.notEqual(select({deployment:'azure_vm',permission_profile:'P1'}),
                  select({deployment:'azure_custom_sessions_hyperv',permission_profile:'P1'}));
});

test('the denial query window extends past the trial by the audit window',()=>{
  const window=denialWindow({start:Date.parse('2026-11-03T04:00:00Z'),end:Date.parse('2026-11-03T04:00:02Z')},300);
  assert.equal(window.from,'2026-11-03T04:00:00.000Z');
  assert.equal(window.to,'2026-11-03T04:05:02.000Z');
});
