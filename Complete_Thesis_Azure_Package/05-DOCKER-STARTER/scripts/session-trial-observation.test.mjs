import test from 'node:test';
import assert from 'node:assert/strict';
import {assessSessionTrialEvidence} from './session-trial-observation.mjs';
import {sessionSeedRequestId} from './azure-session-seed.mjs';

const owner='11111111-1111-4111-8111-111111111111',workload='22222222-2222-4222-8222-222222222222';
const time=n=>new Date(Date.UTC(2026,0,1,0,0,n)).toISOString();
function fixture(scenario='U6') {
  const runId='trial-1',kind=scenario==='U6'?'session-b':'prior-session',id=sessionSeedRequestId(runId,kind);
  const initial={scope:'candidate_lifecycle_observation',runId:'fixture-1',state:'present',sessionFingerprint:'a'.repeat(64),createdAt:time(0),expiresAt:time(50),observedAt:time(3)};
  const lifecycle=scenario==='U8'?{...initial,state:'not_found',observedAt:time(4)}:initial;
  return {trial:{runId,scenario,deployment:'azure_custom_sessions_hyperv'},
    reset:{sessionPreparation:{scope:'session_fixture_preparation',fixtureRunId:'fixture-1',startedAt:time(1),finishedAt:time(2),seed:{runId,kind,status:201,requestId:id,serviceRequestId:'service-id'},initialLifecycle:initial,lifecycle}},
    evidence:{sessionLifecycleAfterExecution:{...lifecycle,observedAt:time(12)},workloadSessionLifecycleAfterExecution:{...initial,runId,sessionFingerprint:'b'.repeat(64),observedAt:time(12)}},
    timing:{executionStartedAt:time(5),executionFinishedAt:time(10)},blobEndpoint:'https://examplestorage.blob.core.windows.net/',blobResourceId:'/subscriptions/example/storage',ownerPrincipalId:owner,workloadPrincipalId:workload,
    seedAuditRows:[{TimeGenerated:time(2),_ResourceId:'/subscriptions/example/storage',Uri:`https://examplestorage.blob.core.windows.net/${kind}/${runId}.json`,RequesterObjectId:owner,AuthenticationType:'OAuth',ClientRequestId:id,OperationName:'PutBlob',StatusCode:201}]};
}
test('session evidence requires separate sessions, audited seeding, and ordered lifecycle observations',()=>{
  for(const scenario of ['U6','U8']) assert.equal(assessSessionTrialEvidence(fixture(scenario)).valid,true);
  let x=fixture(); x.seedAuditRows=[]; assert.equal(assessSessionTrialEvidence(x).reason,'seed_audit_missing_or_ambiguous');
  x=fixture(); x.seedAuditRows[0].RequesterObjectId=workload; assert.equal(assessSessionTrialEvidence(x).reason,'seed_audit_missing_or_ambiguous');
  x=fixture(); x.evidence.workloadSessionLifecycleAfterExecution.sessionFingerprint='a'.repeat(64); assert.equal(assessSessionTrialEvidence(x).reason,'workload_session_unproven');
  x=fixture(); x.evidence.sessionLifecycleAfterExecution.state='not_found'; assert.equal(assessSessionTrialEvidence(x).reason,'other_session_not_proven_active');
  x=fixture('U8'); x.reset.sessionPreparation.lifecycle.observedAt=time(6); assert.equal(assessSessionTrialEvidence(x).reason,'prior_session_retirement_unproven');
  x=fixture(); x.evidence.sessionLifecycleAfterExecution.observedAt=time(9); assert.equal(assessSessionTrialEvidence(x).reason,'fixture_session_followup_unproven');
});
