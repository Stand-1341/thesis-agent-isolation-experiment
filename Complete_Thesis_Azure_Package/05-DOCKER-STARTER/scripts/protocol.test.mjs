/**
 * config/protocol.json is the human-readable record of the study protocol, but
 * nothing in the runner reads it — the trial runners, verifiers and fixture
 * preparers take their values as arguments with their own defaults. That made it
 * free to drift: it still listed the old short deployment names (vm/functions/
 * sessions) that appear nowhere in the frozen matrix, and a 60-second audit
 * window that the verifiers abandoned on 2026-11-02 because a controlled Blob log
 * took over a minute to become queryable.
 *
 * These assertions keep the record honest against the artifact it claims to
 * describe. They do not make the protocol authoritative for execution; wiring that
 * up is a separate change.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loadFrozenSchedule} from './trial-schedule.mjs';

const frozenPlanSha256='39bb833e0a3af2c7bcbd9c7460119cbac97c324cf07bda4ebcc3b10cfd532298';

function loadProtocol(){
  return JSON.parse(readFileSync(new URL('../config/protocol.json',import.meta.url),'utf8'));
}
function loadMatrix(){
  const bytes=readFileSync(new URL('../../03-PLANNED-TRIAL-MATRIX-450.csv',import.meta.url));
  return loadFrozenSchedule(bytes,frozenPlanSha256).rows;
}

test('protocol.json names match the frozen matrix exactly',()=>{
  const protocol=loadProtocol(),rows=loadMatrix();
  const deployments=[...new Set(rows.map(r=>r.deployment))].sort();
  const profiles=[...new Set(rows.map(r=>r.permission_profile))].sort();
  assert.deepEqual([...protocol.deployments].sort(),deployments,
    'protocol deployments must use the matrix deployment names');
  assert.deepEqual([...protocol.profiles].sort(),profiles,
    'protocol profiles must match the matrix permission profiles');

  const scenariosInMatrix=new Set(rows.map(r=>r.scenario_id));
  const declared=new Set([...protocol.unauthorized,...protocol.legitimate]);
  assert.deepEqual([...declared].sort(),[...scenariosInMatrix].sort(),
    'protocol scenario lists must cover exactly the scenarios in the matrix');
  assert.equal(new Set(protocol.unauthorized).size,protocol.unauthorized.length);
  assert.equal(new Set(protocol.legitimate).size,protocol.legitimate.length);
});

test('protocol.json scenario classification matches every matrix row',()=>{
  const protocol=loadProtocol(),rows=loadMatrix();
  const unauthorized=new Set(protocol.unauthorized),legitimate=new Set(protocol.legitimate);
  assert.equal(unauthorized.size+legitimate.size,10,'expected 8 unauthorized + 2 legitimate scenarios');
  for(const row of rows){
    const expected=unauthorized.has(row.scenario_id)?'unauthorized'
      :legitimate.has(row.scenario_id)?'legitimate'
      :null;
    assert.ok(expected,`scenario ${row.scenario_id} is not declared in protocol.json`);
    assert.equal(row.scenario_type,expected,
      `${row.planned_run_id} is typed ${row.scenario_type} but protocol.json says ${expected}`);
  }
});

test('protocol.json trial counts match the frozen matrix',()=>{
  const protocol=loadProtocol(),rows=loadMatrix();
  assert.equal(rows.length,450);
  assert.equal(protocol.expectedDeterministicTrials,rows.length);
  assert.equal(protocol.repetitions,5);
  assert.equal(protocol.plannedLiveAgent.expectedTrials,rows.length);
  // 5 repetitions x 3 deployments x 3 profiles x 10 scenarios
  assert.equal(protocol.repetitions*protocol.deployments.length*protocol.profiles.length
    *(protocol.unauthorized.length+protocol.legitimate.length),rows.length);
});

test('protocol.json audit window cannot be shorter than the documented log latency',()=>{
  const protocol=loadProtocol();
  // Microsoft documents the latency this window has to cover: traffic analytics has a
  // 60-minute default processing interval and "this process can take up to 1 hour",
  // and firewall logs can take 30 minutes before they start populating. A window
  // shorter than an hour cannot observe the deny record it is looking for, and would
  // report "no denial" on trials where the denial exists. It previously sat at 300s
  // with a hard 600s ceiling, which made a correct value unconfigurable.
  assert.ok(protocol.auditWindowSeconds>=3600,
    'auditWindowSeconds must cover the documented up-to-1-hour ingestion latency');
  assert.ok(protocol.auditWindowSeconds<=7200,
    'auditWindowSeconds must stay within the verifier maximum of 7200 seconds');
  assert.ok(protocol.operationTimeoutSeconds>0&&protocol.operationTimeoutSeconds<protocol.auditWindowSeconds,
    'the operation timeout must be shorter than the audit window');
});
