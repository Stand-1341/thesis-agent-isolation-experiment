/**
 * config/protocol.json is the human-readable record of the study protocol and now
 * selects the frozen measured and non-counted pilot schedules. Other trial
 * parameters are still passed to runners, verifiers and fixture preparers. That made it
 * free to drift: it still listed the old short deployment names (vm/functions/
 * sessions) that appear nowhere in the frozen matrix, and a 60-second audit
 * window that the verifiers abandoned on 2026-11-02 because a controlled Blob log
 * took over a minute to become queryable.
 *
 * These assertions keep the record honest against the artifacts it claims to
 * describe. They do not make every protocol field authoritative for execution.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {loadFrozenSchedule} from './trial-schedule.mjs';

const frozenPlanSha256='d904392e7d4f6e3f47ffdacad3cd682350506bc8a4d8123177dd0ca29afce863';

function loadProtocol(){
  return JSON.parse(readFileSync(new URL('../config/protocol.json',import.meta.url),'utf8'));
}
function loadMatrix(){
  const bytes=readFileSync(new URL('../../03-PLANNED-TRIAL-MATRIX-400-REV2.csv',import.meta.url));
  return loadFrozenSchedule(bytes,frozenPlanSha256).rows;
}
function loadPilot(){
  const protocol=loadProtocol();
  const bytes=readFileSync(new URL(`../../${protocol.pilotPlan.file}`,import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),protocol.pilotPlan.sha256,
    'non-counted pilot matrix must match its protocol digest');
  return loadFrozenSchedule(bytes,protocol.pilotPlan.sha256).rows;
}

test('non-counted pilot has a separate frozen 80-row schedule',()=>{
  const protocol=loadProtocol(),rows=loadPilot();
  assert.equal(protocol.pilotPlan.countedAsStudyTrials,false);
  assert.equal(protocol.pilotPlan.trials,80);
  assert.equal(protocol.pilotPlan.derivedFrom,protocol.matrix.sha256);
  assert.equal(rows.length,80);
  assert.ok(rows.every(row=>row.planned_run_id.startsWith('pilot-')));
  assert.equal(rows.some(row=>row.deployment==='azure_custom_sessions_hyperv' && row.permission_profile==='P3'),false);
  assert.equal(new Set(rows.map(row=>`${row.deployment}:${row.permission_profile}`)).size,8);
});

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
  assert.equal(rows.length,protocol.expectedDeterministicTrials);
  assert.equal(protocol.repetitions,5);
  assert.equal(protocol.plannedLiveAgent.expectedTrials,rows.length);
  // Revision 2 withdrew the 50 session-arm P3 cells, so the matrix is no longer the
  // clean product of repetitions x deployments x profiles x scenarios. It is checked
  // against the declared shape instead of being re-derived from the protocol lists.
  const declared=protocol.matrix;
  assert.ok(declared, 'protocol.json must declare the matrix it describes');
  assert.equal(declared.trials,rows.length);
  assert.equal(declared.blocks,new Set(rows.map(row=>row.block)).size);
  assert.equal(declared.rowsPerBlock,rows.length/declared.blocks);
  assert.equal(declared.unauthorized,rows.filter(row=>row.scenario_type==='unauthorized').length);
  assert.equal(declared.legitimate,rows.filter(row=>row.scenario_type==='legitimate').length);
  assert.equal(declared.withdrawn.count,declared.supersedes.trials-declared.trials);
});

test('the declared digest is the digest of the matrix actually in the repository',()=>{
  const protocol=loadProtocol();
  const declared=protocol.matrix;
  const bytes=readFileSync(new URL(`../../${declared.file}`,import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),declared.sha256,
    `${declared.file} no longer matches the digest protocol.json declares`);
  // The superseded revision stays in the repository, unmodified, as the historical plan.
  const priorBytes=readFileSync(new URL(`../../${declared.supersedes.file}`,import.meta.url));
  assert.equal(createHash('sha256').update(priorBytes).digest('hex'),declared.supersedes.sha256,
    'the superseded matrix must not be edited; it is the record of what was planned');
});

test('revision 2 withdraws exactly the session-arm P3 cells and nothing else',()=>{
  const protocol=loadProtocol();
  const current=loadMatrix();
  const prior=loadFrozenSchedule(
    readFileSync(new URL(`../../${protocol.matrix.supersedes.file}`,import.meta.url)),
    protocol.matrix.supersedes.sha256).rows;
  const kept=new Set(current.map(row=>row.planned_run_id));
  const dropped=prior.filter(row=>!kept.has(row.planned_run_id));
  assert.equal(dropped.length,50);
  for(const row of dropped) {
    assert.equal(row.deployment,'azure_custom_sessions_hyperv');
    assert.equal(row.permission_profile,'P3');
  }
  // Every surviving row keeps its original run ID, so evidence stays traceable.
  const priorIds=new Set(prior.map(row=>row.planned_run_id));
  for(const row of current) assert.ok(priorIds.has(row.planned_run_id));
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
