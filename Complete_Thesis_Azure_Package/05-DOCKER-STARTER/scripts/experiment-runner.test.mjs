import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {runExperiment} from './experiment-runner.mjs';
import {implementationManifest} from './implementation-manifest.mjs';
import {loadFrozenSchedule} from './trial-schedule.mjs';

// Frozen digest of the active revision-3 300-row matrix.
const frozenPlanSha256='a6bc3ffe78d677d25e07452e06cfc437062fdd9e8322b4c834d31118337ccc7e';
const matrixHeader=['planned_run_id','block','order_in_block','deployment','permission_profile','scenario_id','scenario_type','status','result','verified_evidence_ref'];

/**
 * Build the matched live-agent draft schedule in memory from the frozen matrix.
 * generate-gpt5mini-live-plan.mjs writes this file into results/, which is
 * gitignored, so reading it from disk made this suite pass only on the machine
 * that had already generated it. Composing it here keeps the test hermetic and
 * byte-identical to the generator's output (same header, same order, "live-" prefix).
 */
function liveDraftPlanBytes(){
  const sourceBytes=readFileSync(new URL('../../03-PLANNED-TRIAL-MATRIX-300-REV3.csv',import.meta.url));
  const {rows}=loadFrozenSchedule(sourceBytes,frozenPlanSha256);
  const csv=[matrixHeader.join(','),
    ...rows.map(row=>matrixHeader.map(key=>(key==='planned_run_id'?`live-${row[key]}`:row[key])).join(',')),
    ''].join('\n');
  return Buffer.from(csv,'utf8');
}

test('composes the frozen schedule, matching route, principal and evidence; stops on indeterminate',async()=>{
  const planBytes=await readFile(new URL('../../03-PLANNED-TRIAL-MATRIX-300-REV3.csv',import.meta.url));
  const planSha256=createHash('sha256').update(planBytes).digest('hex');
  const {rows:scheduledRows}=loadFrozenSchedule(planBytes,planSha256);
  const deployments=['azure_vm','azure_functions_flex'],profiles=['P1','P2','P3'];
  const seen=[],routes={};let n=0;
  for(const deployment of deployments) for(const profile of profiles) {
    const principalObjectId=`00000000-0000-0000-0000-${String(++n).padStart(12,'0')}`;
    routes[`${deployment}:${profile}`]={principalObjectId,adapter:{
      reset:async trial=>{seen.push({deployment,profile,trial});return {};},
      execute:async trial=>({runId:trial.runId,scenario:trial.scenario}),collect:async()=>({})}};
  }
  const records=[],claims=[],evidenceStore={claim:async id=>claims.push(id),save:async record=>records.push(record)};
  const gates={protocolFrozen:true,deploymentValidated:true,isolationValidated:true,verifierValidated:true};
  const verifier=async(trial,{workloadPrincipalId})=>{
    assert.equal(workloadPrincipalId,routes[`${trial.deployment}:${trial.profile}`].principalObjectId);
    return {classification:'indeterminate',evidence:{reason:'simulated pilot only'}};
  };
  const result=await runExperiment({planBytes,planSha256,routes,gates,verifier,evidenceStore,
    rowFilter:new Set([scheduledRows[0].planned_run_id]),networkCapabilities:{azure_vm:true,azure_functions_flex:true}});
  assert.equal(result.length,1);assert.equal(claims.length,1);assert.equal(records.length,1);assert.equal(seen.length,1);
  assert.equal(records[0].trial.planSha256,planSha256);assert.equal(records[0].classification,'indeterminate');
  await assert.rejects(runExperiment({planBytes,planSha256,routes,gates:{...gates,isolationValidated:false},verifier,evidenceStore}),/readiness gates/);
  await assert.rejects(runExperiment({planBytes,planSha256:'0'.repeat(64),routes,gates,verifier,evidenceStore}),/frozen digest/);
  await assert.rejects(runExperiment({planBytes,planSha256,routes,gates,verifier,evidenceStore,arm:'gpt5mini_live'}),/implementation digest required/);
  assert.equal(claims.length,1);
});

test('live phase claim prevents a fresh budget counter after a prior launch',async()=>{
  const planBytes=liveDraftPlanBytes();
  const planSha256=createHash('sha256').update(planBytes).digest('hex');
  const {rows:scheduledRows}=loadFrozenSchedule(planBytes,planSha256);
  const {sha256:implementationSha256}=await implementationManifest();
  const routes={};let n=0,resets=0;
  for(const deployment of ['azure_vm','azure_functions_flex']) for(const profile of ['P1','P2','P3']) {
    routes[`${deployment}:${profile}`]={principalObjectId:`00000000-0000-0000-0000-${String(++n).padStart(12,'0')}`,
      adapter:{reset:async()=>{resets++;return {};},execute:async()=>({}),collect:async()=>({})}};
  }
  const claims=[];
  const evidenceStore={claim:async id=>{claims.push(id);throw new Error('already claimed');},save:async()=>{}};
  const gates={protocolFrozen:true,deploymentValidated:true,isolationValidated:true,verifierValidated:true};
  const args={planBytes,planSha256,routes,gates,verifier:async()=> 'indeterminate',evidenceStore,arm:'gpt5mini_live',
    modelEndpoint:'https://example.openai.azure.com/',getModelToken:async()=> 'test',implementationSha256,
    rowFilter:new Set([scheduledRows[0].planned_run_id]),networkCapabilities:{azure_vm:true,azure_functions_flex:true}};
  await assert.rejects(runExperiment({...args,planSha256:'0'.repeat(64)}),/frozen digest/);
  assert.deepEqual(claims,[]);
  await assert.rejects(runExperiment(args),/already claimed/);
  assert.deepEqual(claims,['phase-gpt5mini-live']);assert.equal(resets,0);
});

test('preflight N/A rows are evidenced without invoking a workload adapter',async()=>{
  const planBytes=await readFile(new URL('../../03-PLANNED-TRIAL-MATRIX-300-REV3.csv',import.meta.url));
  const planSha256=createHash('sha256').update(planBytes).digest('hex');
  const {rows}=loadFrozenSchedule(planBytes,planSha256);
  const row=rows.find(item=>item.deployment==='azure_vm' && item.scenario_id==='U6');
  let adapterCalls=0;const records=[];
  const routes={[`azure_vm:${row.permission_profile}`]:{principalObjectId:'00000000-0000-0000-0000-000000000001',adapter:{
    reset:async()=>{adapterCalls++;},execute:async()=>{adapterCalls++;},collect:async()=>{adapterCalls++;}}}};
  const results=await runExperiment({planBytes,planSha256,routes,
    gates:{protocolFrozen:true,deploymentValidated:true,isolationValidated:true,verifierValidated:true},
    verifier:async()=>({classification:'indeterminate'}),rowFilter:new Set([row.planned_run_id]),
    evidenceStore:{claim:async()=>{},save:async record=>records.push(record)}});
  assert.equal(adapterCalls,0);
  assert.equal(results[0].classification,'not_applicable');
  assert.equal(results[0].executionAttempted,false);
  assert.equal(results.matrixComplete,false);
  assert.equal(records.length,1);
});
