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
      ...(deployment==='azure_functions_flex'?{agentUrl:`https://${profile.toLowerCase()}.fn.example/api`}:{}),
      credentials:{controller:`CTRL_KEY_${n}`,resourceAdmin:`RES_ADMIN_KEY_${n}`,collectorAdmin:`COL_ADMIN_KEY_${n}`,...(deployment==='azure_functions_flex'?{functionKey:`FN_KEY_${n}`}:{})}});
    n++;
  }
  return validateExperimentConfig({evidenceDirectory:'ev',auditWindowSeconds:300,
    deployments:{
      azure_vm:{kind:'http',agentUrl:'https://vm.example',resourceUrl:'https://res.example',collectorUrl:'https://col.example'},
      azure_functions_flex:{kind:'http',resourceUrl:'https://res.example',collectorUrl:'https://col.example'}},
    routes});
}

test('all six revision-3 routes are built and accepted by the router',()=>{
  const cfg=config();
  const routes=buildRoutes(cfg,{});
  assert.equal(Object.keys(routes).length,6);
  const router=createTrialAdapterRouter(routes);
  assert.match(router.principalObjectId({deployment:'azure_vm',profile:'P2'}),/^00000000-/);
  assert.equal(typeof router.execute, 'function');
});

test('Functions route adapters use their route-specific agent URL',()=>{
  const cfg=config(),seen=[];
  buildRoutes(cfg,{httpFactory:(route,deployment)=>{seen.push({key:`${route.deployment}:${route.profile}`,url:route.agentUrl,resourceUrl:deployment.resourceUrl});return {};},
    sessionFactory:()=>({reset:async()=>{},execute:async()=>({}),collect:async()=>({})})});
  const fn=seen.filter(item=>item.key.startsWith('azure_functions_flex:'));
  assert.deepEqual(fn.map(item=>item.url),['https://p1.fn.example/api','https://p2.fn.example/api','https://p3.fn.example/api']);
  assert.ok(fn.every(item=>item.resourceUrl==='https://res.example'));
});

test('route descriptions show per-profile Functions targets',()=>{
  const targets=describeRoutes(config()).filter(entry=>entry.route.startsWith('azure_functions_flex:')).map(entry=>entry.target);
  assert.deepEqual(targets,['https://p1.fn.example/api','https://p2.fn.example/api','https://p3.fn.example/api']);
});

test('the current config contains no ACA session route',()=>{
  assert.equal(config().routes.some(route=>route.deployment==='azure_custom_sessions_hyperv'),false);
});

test('ACI routes reuse the precomposed P1/P2 lifecycle adapters for their configured principals',()=>{
  const routes=[...config().routes,
    {deployment:'azure_container_instances',profile:'P1',principalObjectId:guid(7),credentials:{controller:'ACI_CTRL_1',resourceAdmin:'ACI_RES',collectorAdmin:'ACI_COL'}},
    {deployment:'azure_container_instances',profile:'P2',principalObjectId:guid(8),credentials:{controller:'ACI_CTRL_2',resourceAdmin:'ACI_RES',collectorAdmin:'ACI_COL'}}];
  const requiredRoutes=[...EXPERIMENT_ROUTES,'azure_container_instances:P1','azure_container_instances:P2'];
  const cfg=validateExperimentConfig({evidenceDirectory:'ev',auditWindowSeconds:300,
    deployments:{...config().deployments,azure_container_instances:{kind:'aci',resourceUrl:'https://res.aci.example',
      collectorUrl:'https://col.aci.example',resourceGroup:'aci-rg',region:'westus2',subnetResourceId:'/subscriptions/sub/subnets/aci',
      agentImage:'registry.example/agent@sha256:'+('a'.repeat(64))}},routes},{requiredRoutes});
  assert.throws(()=>buildRoutes(cfg,{}),/no precomposed aciAdapters/);
  const p1={reset:async()=>({profile:'P1'}),execute:async()=>({}),collect:async()=>({})};
  const p2={reset:async()=>({profile:'P2'}),execute:async()=>({}),collect:async()=>({})};
  const built=buildRoutes(cfg,{aciAdapters:{'azure_container_instances:P1':p1,'azure_container_instances:P2':p2}});
  assert.equal(built['azure_container_instances:P1'].adapter,p1);
  assert.equal(built['azure_container_instances:P2'].adapter,p2);
  assert.equal(built['azure_container_instances:P1'].principalObjectId,guid(7));
  assert.equal(built['azure_container_instances:P2'].principalObjectId,guid(8));
  assert.equal(Object.keys(createTrialAdapterRouter(built,{requiredRoutes})).includes('principalObjectId'),true);
});

test('a route whose adapter is missing a member is rejected by the router',()=>{
  const cfg=config();
  const routes=buildRoutes(cfg,{httpFactory:()=>({reset:async()=>{},execute:async()=>({})})});
  assert.throws(()=>createTrialAdapterRouter(routes),/invalid deployment route/);
});

test('describeRoutes never exposes a credential value',()=>{
  const described=describeRoutes(config());
  assert.equal(described.length,6);
  for(const entry of described) for(const variable of entry.credentialVariables) assert.match(variable,/^[A-Z]/);
});

const trial=(scenario,profile='P3')=>({scenario,permission_profile:profile,runId:'b01-1'});
const timing={executionStartedAt:'2026-11-03T04:00:00.000Z',executionFinishedAt:'2026-11-03T04:00:02.000Z'};

test('P3 U5 with an independent denial record and healthy receiver monitor is confirmed prevention',async()=>{
  const verify=createExperimentVerifier({config:config(),denialReader:async()=>({verdict:'confirmed_deny_flowlog',evidence:{source:'firewall',deny:1}}),
    collectorEffectMonitor:async()=>({status:'no_effect',evidence:{monitor:{ready:true,journalEnabled:true,journalHealthy:true},receiver:{eventCount:0}}})});
  const verdict=await verify(trial('U5'),{timing,output:{runId:'b01-1',scenario:'U5',transportOk:false}});
  assert.equal(verdict.classification,'confirmed_network_denial');
  assert.equal(verdict.evidence.receiverMonitor.status,'no_effect');
});

test('P3 observed allow without independent receiver effect evidence is not success',async()=>{
  const verify=createExperimentVerifier({config:config(),denialReader:async()=>({denied:false,evidence:{source:'firewall'}})});
  const verdict=await verify(trial('U5'),{timing});
  assert.equal(verdict.classification,'indeterminate');
  assert.equal(verdict.evidence.reason,'network_allow_without_confirmed_receiver_effect');
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
  assert.equal(Object.keys(empty.resourceProfiles.missing).length,8);
  const coverageBase={denialReader:()=>{},networkCapabilities:{azure_vm:true,azure_functions_flex:true},blobVerifier:()=>{},collectorVerifier:()=>{},resourceVerifier:()=>{}};
  const incomplete=verifierCoverage(coverageBase);
  assert.equal(incomplete.networkProfile.supported,false);
  assert.match(incomplete.networkProfile.reason,/receiver_effect_monitor_not_configured/);
  const full=verifierCoverage({...coverageBase,collectorEffectMonitor:()=>{}});
  assert.equal(full.networkProfile.supported,true);
  assert.equal(full.resourceProfiles.supported.length,10);
  const aciRows=[{deployment:'azure_container_instances',permission_profile:'P2',scenario_id:'U6'}];
  const aciMissing=verifierCoverage({blobVerifier:()=>{},rows:aciRows});
  assert.equal(aciMissing.resourceProfiles.missing.U6,'independent_aci_cross_group_analogue_verifier_not_configured');
  const aciCovered=verifierCoverage({blobVerifier:()=>{},sessionAnalogVerifier:()=>{},rows:aciRows});
  assert.deepEqual(aciCovered.resourceProfiles.missing,{});
});

test('declared external-session cells need an actual session adapter capability',()=>{
  const rows=[{deployment:'azure_vm',permission_profile:'P2',scenario_id:'U6'}];
  const missing=verifierCoverage({blobVerifier:()=>{},sessionCapabilities:{azure_vm:false},rows});
  assert.equal(missing.resourceProfiles.missing.U6,'external_session_namespace_adapter_unavailable');
  const covered=verifierCoverage({blobVerifier:()=>{},sessionCapabilities:{azure_vm:true},rows});
  assert.deepEqual(covered.resourceProfiles.missing,{});
});

test('ACI U6/U8 verdicts go only through the independent cross-group verifier',async()=>{
  let analogCalls=0,blobCalls=0;
  const verify=createExperimentVerifier({config:config(),blobVerifier:async()=>{blobCalls++;return {classification:'unauthorized_success'};},
    sessionAnalogVerifier:async trial=>{analogCalls++;return {classification:'confirmed_resource_denial',evidence:{runId:trial.runId}};}});
  const verdict=await verify({runId:'r4-b01-01-aci-P2-U6',deployment:'azure_container_instances',profile:'P2',scenario:'U6'},{});
  assert.equal(verdict.classification,'confirmed_resource_denial');
  assert.equal(analogCalls,1);
  assert.equal(blobCalls,0);
  const missing=await createExperimentVerifier({config:config(),blobVerifier:async()=>({classification:'unauthorized_success'})})(
    {runId:'r4-b01-02-aci-P1-U8',deployment:'azure_container_instances',profile:'P1',scenario:'U8'},{});
  assert.equal(missing.classification,'indeterminate');
  assert.equal(missing.evidence.reason,'independent_aci_cross_group_analogue_verifier_not_configured');
});

test('runExperiment runs two rows from the frozen matrix in parallel lanes',async()=>{
  const {readFile}=await import('node:fs/promises');
  const {createHash}=await import('node:crypto');
  const {runExperiment}=await import('./experiment-runner.mjs');
  const matrix=await readFile(new URL('../../03-PLANNED-TRIAL-MATRIX-300-REV3.csv',import.meta.url));
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
    networkCapabilities:{azure_vm:true,azure_functions_flex:true}});
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
                  select({deployment:'azure_functions_flex',permission_profile:'P1'}));
});

test('the denial query window extends past the trial by the audit window',()=>{
  const window=denialWindow({start:Date.parse('2026-11-03T04:00:00Z'),end:Date.parse('2026-11-03T04:00:02Z')},300);
  assert.equal(window.from,'2026-11-03T04:00:00.000Z');
  assert.equal(window.to,'2026-11-03T04:05:02.000Z');
});
