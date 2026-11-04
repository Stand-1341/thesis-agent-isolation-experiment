import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {runTrial} from './trial-runner.mjs';
import {readEvidence} from './evidence-store.mjs';

test('gates stop execution; a claimed trial cannot execute twice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'trial-runner-'));
  try {
    let executions = 0;
    const adapter = {reset:async()=>({marker:'synthetic'}), execute:async t=>{executions++; return {runId:t.runId,scenario:t.scenario,status:200};}, collect:async()=>({events:[]})};
    const trial={runId:'test-1',scenario:'L1'};
    const gates={protocolFrozen:true,deploymentValidated:true,isolationValidated:true,verifierValidated:true};
    const args={trial,gates,adapter,verifier:async()=> 'legitimate_completion',evidenceDirectory:dir};
    await assert.rejects(runTrial({...args,gates:{}}), /readiness/);
    assert.equal(executions,0);
    await runTrial(args);
    const saved=await readEvidence(join(dir,'test-1.json'));
    assert.equal(saved.classification,'legitimate_completion');
    assert.ok(Date.parse(saved.executionStartedAt)>=Date.parse(saved.startedAt));
    assert.ok(Date.parse(saved.executionFinishedAt)>=Date.parse(saved.executionStartedAt));
    assert.ok(Number.isInteger(saved.executionElapsedMs) && saved.executionElapsedMs>=0);
    await assert.rejects(runTrial(args), {code:'EEXIST'});
    assert.equal(executions,1);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('a non-counted pilot can exercise an adapter with gates false and is labeled',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'trial-pilot-'));
  try {
    let executions=0;
    const adapter={reset:async()=>({marker:'synthetic'}),execute:async t=>{executions++;return {runId:t.runId,scenario:t.scenario,status:200};},collect:async()=>({events:[]})};
    const record=await runTrial({trial:{runId:'pilot-azure_vm-P1-U1',scenario:'U1'},gates:{},adapter,
      verifier:async()=> 'unauthorized_success',evidenceDirectory:dir,mode:'non_counted_pilot'});
    assert.equal(executions,1);
    assert.equal(record.mode,'non_counted_pilot');
    assert.equal(record.classification,'unauthorized_success');
    const saved=await readEvidence(join(dir,'pilot-azure_vm-P1-U1.json'));
    assert.equal(saved.mode,'non_counted_pilot');
    await assert.rejects(runTrial({trial:{runId:'planned-1',scenario:'U1'},gates:{},adapter,
      verifier:async()=> 'unauthorized_success',evidenceDirectory:dir,mode:'non_counted_pilot'}),/run mode/);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('a collection failure preserves the prior response as indeterminate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'trial-runner-'));
  try {
    const gates={protocolFrozen:true,deploymentValidated:true,isolationValidated:true,verifierValidated:true};
    const adapter={reset:async()=>({marker:'synthetic'}),execute:async t=>({runId:t.runId,scenario:t.scenario,status:200}),collect:async()=>{throw new Error('offline');}};
    await assert.rejects(runTrial({trial:{runId:'test-2',scenario:'U1'},gates,adapter,verifier:async()=> 'unauthorized_success',evidenceDirectory:dir}), /offline/);
    const saved=await readEvidence(join(dir,'test-2.json'));
    assert.equal(saved.classification,'indeterminate');
    assert.equal(saved.failedStage,'collect');
    assert.equal(saved.output.status,200);
    assert.ok(Date.parse(saved.executionFinishedAt)>=Date.parse(saved.executionStartedAt));
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('records sanitized partial Azure fixture writes without executing',async()=>{
  const records=[];let executed=false;
  const evidenceStore={claim:async()=>{},save:async record=>records.push(record)};
  const adapter={reset:async()=>{const e=new Error('fixture failed');e.azureFixtureProgress={scope:'azure_fixture_seed_progress',confirmedWrites:3,outcome:'incomplete_or_unknown',secret:'discard'};throw e;},
    execute:async()=>{executed=true;},collect:async()=>({})};
  await assert.rejects(runTrial({trial:{runId:'partial-azure',scenario:'U1'},gates:{protocolFrozen:true,deploymentValidated:true,isolationValidated:true,verifierValidated:true},
    adapter,verifier:async()=>{},evidenceStore}),/fixture failed/);
  assert.equal(executed,false);assert.equal(records[0].classification,'indeterminate');
  assert.deepEqual(records[0].azureFixtureProgress,{scope:'azure_fixture_seed_progress',confirmedWrites:3,outcome:'incomplete_or_unknown'});
});

test('preserves sanitized partial reset evidence without executing the trial',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'trial-runner-'));
  try {
    const gates={protocolFrozen:true,deploymentValidated:true,isolationValidated:true,verifierValidated:true};
    let executed=false;
    const adapter={reset:async()=>{const e=new Error('collector reset failed');e.partialReset={scope:'fixture_reset_progress',resourceResetCompleted:true,collectorResetConfirmed:false,collectorOutcome:'unknown',secret:'must-not-save'};throw e;},execute:async()=>{executed=true;},collect:async()=>({})};
    await assert.rejects(runTrial({trial:{runId:'partial-reset',scenario:'U1'},gates,adapter,verifier:async()=> 'indeterminate',evidenceDirectory:dir}),/collector reset failed/);
    const saved=await readEvidence(join(dir,'partial-reset.json'));
    assert.equal(executed,false);assert.equal(saved.classification,'indeterminate');assert.equal(saved.failedStage,'reset');
    assert.deepEqual(saved.partialResetEvidence,{scope:'fixture_reset_progress',resourceResetCompleted:true,collectorResetConfirmed:false,collectorOutcome:'unknown'});
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('a mismatched response is retained as indeterminate and is never verified', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'trial-runner-'));
  try {
    let verified=false;
    const gates={protocolFrozen:true,deploymentValidated:true,isolationValidated:true,verifierValidated:true};
    const adapter={reset:async()=>({}),execute:async()=>({runId:'other-run',scenario:'U1',status:200}),collect:async()=>({})};
    await assert.rejects(runTrial({trial:{runId:'test-3',scenario:'U1'},gates,adapter,verifier:async()=>{verified=true;},evidenceDirectory:dir}),/does not match/);
    const saved=await readEvidence(join(dir,'test-3.json'));
    assert.equal(saved.classification,'indeterminate');
    assert.equal(saved.failedStage,'validate_response');
    assert.equal(saved.output.runId,'other-run');
    assert.equal(verified,false);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('sensitive-value exposure stops before verification or cleanup',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'trial-runner-'));
  try {
    const gates={protocolFrozen:true,deploymentValidated:true,isolationValidated:true,verifierValidated:true};
    let verified=false,cleaned=false,collected=false;
    const adapter={reset:async()=>({}),execute:async t=>({runId:t.runId,scenario:t.scenario,transportOk:false,errorType:'ControlTokenExposed'}),
      collect:async()=>{collected=true;return {};},cleanup:async()=>{cleaned=true;}};
    await assert.rejects(runTrial({trial:{runId:'exposure',scenario:'U1'},gates,adapter,verifier:async()=>{verified=true;return 'confirmed_network_denial';},evidenceDirectory:dir}),/exposure requires investigation/);
    const saved=await readEvidence(join(dir,'exposure.json'));
    assert.equal(saved.classification,'indeterminate');assert.equal(saved.failedStage,'security_observation');
    assert.equal(saved.output.errorType,'ControlTokenExposed');
    assert.equal(verified,false);assert.equal(collected,false);assert.equal(cleaned,false);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('persists verifier-supplied evidence with its classification',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'trial-runner-'));
  try {
    const gates={protocolFrozen:true,deploymentValidated:true,isolationValidated:true,verifierValidated:true};
    const adapter={reset:async()=>({}),execute:async t=>({runId:t.runId,scenario:t.scenario}),collect:async()=>({})};
    const verifier=async()=>({classification:'indeterminate',evidence:{reason:'audit_missing'}});
    await runTrial({trial:{runId:'test-4',scenario:'U1'},gates,adapter,verifier,evidenceDirectory:dir});
    assert.equal((await readEvidence(join(dir,'test-4.json'))).verificationEvidence.reason,'audit_missing');
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('preserves the trial before cleanup and stops if cleanup fails',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'trial-runner-'));
  try {
    const gates={protocolFrozen:true,deploymentValidated:true,isolationValidated:true,verifierValidated:true};
    const adapter={reset:async()=>({}),execute:async t=>({runId:t.runId,scenario:t.scenario}),collect:async()=>({}),
      cleanup:async trial=>{assert.equal((await readEvidence(join(dir,`${trial.runId}.json`))).classification,'legitimate_completion');throw new Error('cleanup unavailable');}};
    await assert.rejects(runTrial({trial:{runId:'test-5',scenario:'L1'},gates,adapter,verifier:async()=> 'legitimate_completion',evidenceDirectory:dir}),/cleanup failed/);
    const cleanupId=`cleanup-${createHash('sha256').update('test-5').digest('hex')}`;
    assert.equal((await readEvidence(join(dir,'test-5.json'))).classification,'legitimate_completion');
    assert.equal((await readEvidence(join(dir,`${cleanupId}.json`))).status,'failed');
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('does not clean up an indeterminate session before investigation',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'trial-runner-'));
  try {
    let cleaned=false;
    const gates={protocolFrozen:true,deploymentValidated:true,isolationValidated:true,verifierValidated:true};
    const adapter={reset:async()=>({}),execute:async t=>({runId:t.runId,scenario:t.scenario}),collect:async()=>({}),cleanup:async()=>{cleaned=true;}};
    await runTrial({trial:{runId:'test-6',scenario:'U1'},gates,adapter,verifier:async()=> 'indeterminate',evidenceDirectory:dir});
    assert.equal(cleaned,false);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('ACI opt-in cleanup runs after an indeterminate classification and records deletion',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'trial-aci-cleanup-'));
  try {
    let cleaned=false;
    const gates={protocolFrozen:true,deploymentValidated:true,isolationValidated:true,verifierValidated:true};
    const adapter={cleanupOnFailure:true,reset:async()=>({}),execute:async t=>({runId:t.runId,scenario:t.scenario}),collect:async()=>({}),
      cleanup:async()=>{cleaned=true;return {groupName:'thesis-aci-p1-deadbeef',deleted:true};}};
    const record=await runTrial({trial:{runId:'pilot-aci-indeterminate',scenario:'U1'},gates,adapter,
      verifier:async()=>({classification:'indeterminate',evidence:{reason:'audit_missing'}}),evidenceDirectory:dir,mode:'non_counted_pilot'});
    assert.equal(record.classification,'indeterminate');
    assert.equal(cleaned,true);
    const cleanupId=`cleanup-${createHash('sha256').update('pilot-aci-indeterminate').digest('hex')}`;
    const cleanup=await readEvidence(join(dir,`${cleanupId}.json`));
    assert.equal(cleanup.status,'completed');
    assert.deepEqual(cleanup.outcome,{groupName:'thesis-aci-p1-deadbeef',deleted:true});
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('ACI opt-in cleanup runs and is recorded after an execution failure',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'trial-aci-failure-cleanup-'));
  try {
    let cleaned=false;
    const adapter={cleanupOnFailure:true,reset:async()=>({}),execute:async()=>{throw new Error('agent readiness timeout');},collect:async()=>({}),
      cleanup:async()=>{cleaned=true;return {groupName:'thesis-aci-p1-deadbeef',deleted:true};}};
    await assert.rejects(runTrial({trial:{runId:'pilot-aci-failed',scenario:'U1'},gates:{},adapter,
      verifier:async()=> 'indeterminate',evidenceDirectory:dir,mode:'non_counted_pilot'}),/agent readiness timeout/);
    assert.equal(cleaned,true);
    assert.equal((await readEvidence(join(dir,'pilot-aci-failed.json'))).classification,'indeterminate');
    const cleanupId=`cleanup-${createHash('sha256').update('pilot-aci-failed').digest('hex')}`;
    assert.equal((await readEvidence(join(dir,`${cleanupId}.json`))).status,'completed');
  } finally {await rm(dir,{recursive:true,force:true});}
});
