import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {loadFrozenSchedule,runSchedule} from './trial-schedule.mjs';
import {runScheduleParallel} from './parallel-schedule.mjs';
import {createAzureBlobVerifier} from './azure-blob-verifier.mjs';

const MATRIX_URL=new URL('../../03-PLANNED-TRIAL-MATRIX-300-REV3.csv',import.meta.url);
const bytes=readFileSync(MATRIX_URL);
const sha=createHash('sha256').update(bytes).digest('hex');
const protocol=JSON.parse(readFileSync(new URL('../config/protocol.json',import.meta.url),'utf8'));
const plan=loadFrozenSchedule(bytes,sha);

const guid='11111111-1111-4111-8111-111111111111';
const verifierOptions={
  readAudit:async()=>[],
  principalForTrial:()=>guid,
  blobEndpoint:'https://example.blob.core.windows.net',
  blobResourceId:'/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/acct',
  workspaceId:guid,
  sessionFixtureOwnerPrincipalId:guid,
  sessionDataCapabilities:{},
  auditPipelineValidated:true,
  authorizationValidated:true,
  clockSyncValidated:true,
  auditWaitMs:0,
  wait:async()=>{}
};
const verifier=createAzureBlobVerifier(verifierOptions);

test('the protocol audit window now covers the documented ingestion latency',()=>{
  assert.equal(protocol.auditWindowSeconds,3600);
});

test('exactly 60 scheduled trials are cross-session scenarios on a sessionless deployment',()=>{
  const rows=plan.rows.filter(row=>['U6','U8'].includes(row.scenario_id) &&
    row.deployment!=='azure_custom_sessions_hyperv');
  assert.equal(rows.length,60);
  // 2 scenarios x 2 sessionless deployments x 3 profiles x 5 repetitions
  assert.equal(rows.length,2*2*3*5);
});

test('every one of those 60 is declared out of scope, not indeterminate',async()=>{
  const rows=plan.rows.filter(row=>['U6','U8'].includes(row.scenario_id) &&
    row.deployment!=='azure_custom_sessions_hyperv');
  for(const row of rows) {
    const verdict=await verifier({scenario:row.scenario_id,deployment:row.deployment,
      permission_profile:row.permission_profile}, {timing:{}});
    assert.equal(verdict.classification,'not_applicable',`${row.planned_run_id} (${row.scenario_id}/${row.deployment})`);
    assert.equal(verdict.evidence.reason,'scenario_requires_sessions');
  }
});

test('an explicitly unavailable external session adapter is not misreported as a measured failure',async()=>{
  const unavailable=createAzureBlobVerifier({...verifierOptions,sessionDataCapabilities:{azure_functions_flex:false}});
  const verdict=await unavailable({scenario:'U6',deployment:'azure_functions_flex',permission_profile:'P2'}, {timing:{}});
  assert.equal(verdict.classification,'not_applicable');
  assert.equal(verdict.evidence.reason,'scenario_requires_sessions');
});

test('enabled external-session verification requires independently observed namespace fixtures',async()=>{
  const enabled=createAzureBlobVerifier({...verifierOptions,sessionDataCapabilities:{azure_functions_flex:true}});
  const verdict=await enabled({runId:'external-fixture-missing',scenario:'U6',deployment:'azure_functions_flex',permission_profile:'P1'},
    {reset:{},output:{status:200},evidence:{},timing:{executionStartedAt:'2026-11-05T12:00:00.000Z',executionFinishedAt:'2026-11-05T12:00:01.000Z'}});
  assert.equal(verdict.classification,'indeterminate');
  assert.equal(verdict.evidence.reason,'external_session_namespace_fixture_missing');
});

const isScopeGap=trial=>['U6','U8'].includes(trial.scenario) && trial.deployment!=='azure_custom_sessions_hyperv';

test('the full 300-trial matrix has 60 declared out-of-scope U6/U8 rows',async()=>{
  // This is the run that used to halt around trial 21. Every row executes; the 60
  // cross-session cells on sessionless deployments are recorded as scope gaps.
  const results=await runSchedule(plan.rows,async trial=>({runId:trial.runId,
    classification:isScopeGap(trial)?'not_applicable':'unauthorized_success'}));
  assert.equal(results.length,300);
  assert.equal(results.halted,false);
  assert.equal(results.complete,true);
  assert.equal(results.notApplicable,60);
});

test('an indeterminate trial still halts, so the distinction survives',async()=>{
  const poison=plan.rows[1].planned_run_id;
  const results=await runSchedule(plan.rows,async trial=>({runId:trial.runId,
    classification:trial.runId===poison?'indeterminate':'unauthorized_success'}));
  assert.equal(results.halted,true);
  assert.equal(results.complete,false);
  assert.equal(results.length,2);
});

test('a scope gap does not halt the parallel schedule either',async()=>{
  const rows=plan.rows.filter(row=>['U6','U8'].includes(row.scenario_id) &&
    row.deployment!=='azure_custom_sessions_hyperv');
  const results=await runScheduleParallel(rows,async trial=>({runId:trial.runId,classification:'not_applicable'}),
    {concurrency:3});
  assert.equal(results.length,60);
  assert.equal(results.halted,false);
  assert.equal(results.complete,true);
  assert.equal(results.notApplicable,60);
});

test('the revision-3 matrix has no ACA session arm',()=>{
  assert.equal(plan.rows.some(row=>row.deployment==='azure_custom_sessions_hyperv'),false);
});
