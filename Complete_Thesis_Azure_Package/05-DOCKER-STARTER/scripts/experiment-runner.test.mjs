import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {runExperiment} from './experiment-runner.mjs';
import {implementationManifest} from './implementation-manifest.mjs';

test('composes the frozen schedule, matching route, principal and evidence; stops on indeterminate',async()=>{
  const planBytes=await readFile(new URL('../../03-PLANNED-TRIAL-MATRIX-450.csv',import.meta.url));
  const planSha256=createHash('sha256').update(planBytes).digest('hex');
  const deployments=['azure_vm','azure_functions_flex','azure_custom_sessions_hyperv'],profiles=['P1','P2','P3'];
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
  const result=await runExperiment({planBytes,planSha256,routes,gates,verifier,evidenceStore});
  assert.equal(result.length,1);assert.equal(claims.length,1);assert.equal(records.length,1);assert.equal(seen.length,1);
  assert.equal(records[0].trial.planSha256,planSha256);assert.equal(records[0].classification,'indeterminate');
  await assert.rejects(runExperiment({planBytes,planSha256,routes,gates:{...gates,isolationValidated:false},verifier,evidenceStore}),/readiness gates/);
  await assert.rejects(runExperiment({planBytes,planSha256:'0'.repeat(64),routes,gates,verifier,evidenceStore}),/frozen digest/);
  await assert.rejects(runExperiment({planBytes,planSha256,routes,gates,verifier,evidenceStore,arm:'gpt5mini_live'}),/implementation digest required/);
  assert.equal(claims.length,1);
});

test('live phase claim prevents a fresh budget counter after a prior launch',async()=>{
  const planBytes=await readFile(new URL('../results/gpt5mini-live-agent-plan.draft-v11.csv',import.meta.url));
  const planSha256=createHash('sha256').update(planBytes).digest('hex');
  const {sha256:implementationSha256}=await implementationManifest();
  const routes={};let n=0,resets=0;
  for(const deployment of ['azure_vm','azure_functions_flex','azure_custom_sessions_hyperv']) for(const profile of ['P1','P2','P3']) {
    routes[`${deployment}:${profile}`]={principalObjectId:`00000000-0000-0000-0000-${String(++n).padStart(12,'0')}`,
      adapter:{reset:async()=>{resets++;return {};},execute:async()=>({}),collect:async()=>({})}};
  }
  const claims=[];
  const evidenceStore={claim:async id=>{claims.push(id);throw new Error('already claimed');},save:async()=>{}};
  const gates={protocolFrozen:true,deploymentValidated:true,isolationValidated:true,verifierValidated:true};
  const args={planBytes,planSha256,routes,gates,verifier:async()=> 'indeterminate',evidenceStore,arm:'gpt5mini_live',
    modelEndpoint:'https://example.openai.azure.com/',getModelToken:async()=> 'test',implementationSha256};
  await assert.rejects(runExperiment({...args,planSha256:'0'.repeat(64)}),/frozen digest/);
  assert.deepEqual(claims,[]);
  await assert.rejects(runExperiment(args),/already claimed/);
  assert.deepEqual(claims,['phase-gpt5mini-live']);assert.equal(resets,0);
});
