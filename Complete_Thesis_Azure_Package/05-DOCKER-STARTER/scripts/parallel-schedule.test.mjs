import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runScheduleParallel,laneByDeployment} from './parallel-schedule.mjs';

const row=(id,deployment,scenario='U1',profile='P1')=>({planned_run_id:id,block:1,order_in_block:1,
  deployment,permission_profile:profile,scenario_id:scenario,status:'NOT RUN',result:'',verified_evidence_ref:''});

const threeLanes=[
  row('a1','azure_vm'),row('b1','azure_functions_flex'),row('c1','azure_custom_sessions_hyperv'),
  row('a2','azure_vm'),row('b2','azure_functions_flex'),row('c2','azure_custom_sessions_hyperv')
];

test('rows in different deployments run at the same time',async()=>{
  let inFlight=0, peak=0;
  const done=[];
  await runScheduleParallel(threeLanes,async trial=>{
    inFlight++; peak=Math.max(peak,inFlight);
    await new Promise(resolve=>setTimeout(resolve,10));
    inFlight--; done.push(trial.runId);
    return {runId:trial.runId,classification:'unauthorized_success'};
  },{concurrency:3});
  assert.equal(peak,3,'three lanes should overlap');
  assert.equal(done.length,6);
});

test('two rows sharing a lane never run concurrently',async()=>{
  const perLane=new Map();
  let overlap=false;
  await runScheduleParallel(threeLanes,async trial=>{
    const current=(perLane.get(trial.deployment)??0)+1;
    perLane.set(trial.deployment,current);
    if(current>1) overlap=true;
    await new Promise(resolve=>setTimeout(resolve,5));
    perLane.set(trial.deployment,perLane.get(trial.deployment)-1);
    return {runId:trial.runId,classification:'unauthorized_success'};
  },{concurrency:3});
  assert.equal(overlap,false,'a deployment is a single-fixture lane');
});

test('results come back in schedule order regardless of completion order',async()=>{
  const durations={a1:30,a2:1,b1:1,b2:1,c1:1,c2:1};
  const results=await runScheduleParallel(threeLanes,async trial=>{
    await new Promise(resolve=>setTimeout(resolve,durations[trial.runId]));
    return {runId:trial.runId,classification:'unauthorized_success'};
  },{concurrency:3});
  assert.deepEqual(results.map(record=>record.runId),threeLanes.map(entry=>entry.planned_run_id));
  assert.equal(results.complete,true);
});

test('one indeterminate trial stops every lane from taking new work',async()=>{
  let started=0;
  const results=await runScheduleParallel(threeLanes,async trial=>{
    started++;
    if(trial.runId==='b1') return {runId:trial.runId,classification:'indeterminate'};
    await new Promise(resolve=>setTimeout(resolve,15));
    return {runId:trial.runId,classification:'unauthorized_success'};
  },{concurrency:3});
  assert.equal(results.halted,true);
  assert.equal(results.haltedAt,'b1');
  assert.equal(results.complete,false);
  // The two trials already in flight finish; the second row of each lane does not start.
  assert.ok(started<6,`expected fewer than 6 trials to start, got ${started}`);
});

test('a thrown error propagates after the other lanes drain',async()=>{
  const finished=[];
  await assert.rejects(()=>runScheduleParallel(threeLanes,async trial=>{
    if(trial.runId==='a2') throw new Error('fixture reset failed');
    await new Promise(resolve=>setTimeout(resolve,5));
    finished.push(trial.runId);
    return {runId:trial.runId,classification:'unauthorized_success'};
  },{concurrency:3}),/fixture reset failed/);
  assert.ok(finished.length>=2,'in-flight lanes should have completed');
});

test('a duplicate run ID is refused before anything executes',async()=>{
  const rows=[row('x','azure_vm'),row('x','azure_vm')];
  await assert.rejects(()=>runScheduleParallel(rows,async trial=>({runId:trial.runId,classification:'unauthorized_success'}),{}),/duplicate run ID/);
});

test('an invalid classification stops the run like a bad record',async()=>{
  await assert.rejects(()=>runScheduleParallel([row('y','azure_vm')],async trial=>({runId:trial.runId,classification:'looks_fine'}),{}),/invalid classification/);
});

test('concurrency is bounded even when asked for more lanes than exist',async()=>{
  let peak=0,inFlight=0;
  const rows=[row('m1','azure_vm'),row('m2','azure_vm')];
  const results=await runScheduleParallel(rows,async trial=>{
    inFlight++; peak=Math.max(peak,inFlight);
    await new Promise(resolve=>setTimeout(resolve,5));
    inFlight--;
    return {runId:trial.runId,classification:'unauthorized_success'};
  },{concurrency:8});
  assert.equal(peak,1,'one deployment is one lane however many workers you ask for');
  assert.equal(results.concurrency,1);
});

test('a custom lane function can widen concurrency when fixtures are separate',async()=>{
  const rows=[row('p1','azure_vm','U1','P1'),row('p2','azure_vm','U1','P2'),row('p3','azure_vm','U1','P3')];
  let peak=0,inFlight=0;
  const results=await runScheduleParallel(rows,async trial=>{
    inFlight++; peak=Math.max(peak,inFlight);
    await new Promise(resolve=>setTimeout(resolve,10));
    inFlight--;
    return {runId:trial.runId,classification:'unauthorized_success'};
  },{laneFor:entry=>`${entry.deployment}:${entry.permission_profile}`,concurrency:3});
  assert.equal(peak,3,'three profiles with separate fixtures are three lanes');
  assert.equal(results.laneCount,3);
});

test('the default lane key is the deployment',()=>{
  assert.equal(laneByDeployment({deployment:'azure_vm',permission_profile:'P2'}),'azure_vm');
});
