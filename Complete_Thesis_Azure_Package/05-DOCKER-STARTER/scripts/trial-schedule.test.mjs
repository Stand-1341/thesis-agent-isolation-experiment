import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runSchedule,validateSchedule,verifyPlanDigest,loadFrozenSchedule,runFrozenSchedule} from './trial-schedule.mjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';

function plan() {
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
test('validates all cells before execution and stops after an indeterminate result', async()=>{
  const rows=plan();
  assert.equal(validateSchedule(rows).unauthorized,360);
  let calls=0;
  const results=await runSchedule(rows,async trial=>({runId:trial.runId,classification:++calls===2?'indeterminate':'unauthorized_success'}));
  assert.equal(results.length,2);
  assert.equal(calls,2);
  rows[449].scenario_id=rows[448].scenario_id;
  await assert.rejects(runSchedule(rows,async()=>{throw Error('must not run');}));
});

test('loads the supplied matrix only when its complete byte digest matches',async()=>{
  const path=fileURLToPath(new URL('../../03-PLANNED-TRIAL-MATRIX-400-REV2.csv',import.meta.url));
  const python='import csv,json,sys; f=open(sys.argv[1],encoding="utf-8-sig",newline=""); print(json.dumps(list(csv.DictReader(f))))';
  // Stock Debian/Ubuntu ships python3 only; a hardcoded 'python' made this structural
  // check fail before it ever reached the digest assertion. Probe for an interpreter.
  const interpreter=['python3','python','py'].find(bin=>{
    try {return spawnSync(bin,['-c','import csv,json'],{encoding:'utf8'}).status===0;} catch {return false;}
  });
  assert.ok(interpreter,'python3 is required to cross-check the matrix structure');
  const result=spawnSync(interpreter,['-c',python,path],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.equal(validateSchedule(JSON.parse(result.stdout)).rows,400);
  const bytes=readFileSync(path);
  const hash='d904392e7d4f6e3f47ffdacad3cd682350506bc8a4d8123177dd0ca29afce863';
  assert.equal(verifyPlanDigest(bytes,hash),hash);
  assert.throws(()=>verifyPlanDigest(Buffer.concat([bytes,Buffer.from('x')]),hash),/differs/);
  assert.equal(loadFrozenSchedule(bytes,hash).rows.length,400);
  let calls=0;
  await assert.rejects(runFrozenSchedule(Buffer.concat([bytes,Buffer.from('x')]),hash,async()=>{calls++;}),/differs/);
  assert.equal(calls,0);
  const resultRows=await runFrozenSchedule(bytes,hash,async trial=>{calls++;assert.equal(trial.planSha256,hash);return {runId:trial.runId,classification:'indeterminate'};});
  assert.equal(resultRows.length,1);
  assert.equal(calls,1);
});
