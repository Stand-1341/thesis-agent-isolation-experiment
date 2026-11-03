/**
 * runSchedule stops at the first indeterminate trial and returns what it has. The
 * array it returned was indistinguishable from a completed run unless the caller
 * happened to compare its length to 450 — so a matrix that halted at row 2 could be
 * read as a successful run. These assertions pin the halt signal and the integrity
 * checks that guard the schedule in the first place.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runSchedule} from './trial-schedule.mjs';

function plan(){
  const rows=[];
  for (let block=1;block<=5;block++) {
    let order=0;
    for (const deployment of ['azure_vm','azure_functions_flex','azure_custom_sessions_hyperv'])
      for (const permission_profile of ['P1','P2','P3'])
        for (const scenario_id of ['U1','U2','U3','U4','U5','U6','U7','U8','L1','L2']) {
          order++;
          rows.push({block,order_in_block:order,planned_run_id:`b${block}-${order}`,deployment,permission_profile,scenario_id,
            scenario_type:scenario_id[0]==='U'?'unauthorized':'legitimate',status:'NOT RUN',result:'',verified_evidence_ref:''});
        }
  }
  return rows;
}

test('a halted schedule reports itself as halted, not as a complete matrix',async()=>{
  const results=await runSchedule(plan(),async trial=>({runId:trial.runId,classification:'indeterminate'}));
  assert.equal(results.length,1);
  assert.equal(results.halted,true);
  assert.equal(results.complete,false);
  assert.equal(results.haltedAt,results[0].runId);
});

test('a schedule that runs to the end is marked complete',async()=>{
  const rows=plan();
  const results=await runSchedule(rows,async trial=>({runId:trial.runId,classification:'unauthorized_success'}));
  assert.equal(results.length,rows.length);
  assert.equal(results.halted,false);
  assert.equal(results.complete,true);
  assert.equal(results.haltedAt,null);
});

test('the halt properties do not leak into serialised output',async()=>{
  const results=await runSchedule(plan(),async trial=>({runId:trial.runId,classification:'indeterminate'}));
  const roundTrip=JSON.parse(JSON.stringify(results));
  assert.ok(Array.isArray(roundTrip));
  assert.equal(roundTrip.length,1);
  assert.equal(roundTrip.halted,undefined);
});

test('an invalid classification still stops the run before it is recorded',async()=>{
  let calls=0;
  await assert.rejects(
    runSchedule(plan(),async trial=>{calls++;return {runId:trial.runId,classification:'looks_fine_trust_me'};}),
    /invalid classification/);
  assert.equal(calls,1);
});
