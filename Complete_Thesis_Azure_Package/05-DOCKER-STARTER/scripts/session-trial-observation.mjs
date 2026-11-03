/** Validate candidate custom-pool session observations, not their cloud provenance. */
import {findBlobAuditCandidates} from './blob-audit-observations.mjs';
import {sessionSeedRequestId} from './azure-session-seed.mjs';
const guid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fingerprint=/^[a-f0-9]{64}$/;
const at=value=>typeof value==='string'?Date.parse(value):NaN;

export function assessSessionTrialEvidence({trial,reset,evidence,timing,seedAuditRows,blobEndpoint,blobResourceId,ownerPrincipalId,workloadPrincipalId}) {
  const scope='candidate_session_observation_not_final_verdict';
  const fail=reason=>({scope,valid:false,reason});
  if(trial?.deployment!=='azure_custom_sessions_hyperv' || !['U6','U8'].includes(trial.scenario)) return fail('unsupported_deployment_or_scenario');
  if(!guid.test(ownerPrincipalId || '') || !guid.test(workloadPrincipalId || '') || ownerPrincipalId.toLowerCase()===workloadPrincipalId.toLowerCase()) return fail('invalid_principal_separation');
  const prep=reset?.sessionPreparation,initial=prep?.initialLifecycle,after=evidence?.sessionLifecycleAfterExecution,
    workload=evidence?.workloadSessionLifecycleAfterExecution,kind=trial.scenario==='U6'?'session-b':'prior-session';
  const start=at(timing?.executionStartedAt),end=at(timing?.executionFinishedAt),seedStart=at(prep?.startedAt),seedEnd=at(prep?.finishedAt);
  if(![start,end,seedStart,seedEnd].every(Number.isFinite) || end<start || seedEnd<seedStart || seedEnd>start) return fail('invalid_execution_timing');
  if(prep?.scope!=='session_fixture_preparation' || prep.seed?.runId!==trial.runId || prep.seed?.kind!==kind || prep.seed?.status!==201 ||
    prep.seed?.requestId!==sessionSeedRequestId(trial.runId,kind) || !prep.seed?.serviceRequestId) return fail('invalid_session_seed');
  let blob; try {blob=new URL(blobEndpoint);} catch {return fail('invalid_blob_endpoint');}
  if(blob.protocol!=='https:' || !/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(blob.hostname) || blob.pathname!=='/' || blob.search || blob.hash || blob.username || blob.password || blob.port) return fail('invalid_blob_endpoint');
  let seedAudit;
  try {seedAudit=findBlobAuditCandidates(seedAuditRows,{resourceId:blobResourceId,principalId:ownerPrincipalId,runId:trial.runId,
    clientRequestId:prep.seed.requestId,expectedUrl:`${blob.origin}/${kind}/${trial.runId}.json`,operation:'PutBlob',startMs:Math.max(0,seedStart-10000),endMs:seedEnd+10000});}
  catch {return fail('invalid_seed_audit');}
  if(seedAudit.matches.length!==1 || seedAudit.matches[0].statusCode!==201) return fail('seed_audit_missing_or_ambiguous');
  if(initial?.scope!=='candidate_lifecycle_observation' || initial.runId!==prep.fixtureRunId || initial.state!=='present' ||
    !fingerprint.test(initial.sessionFingerprint || '') || !Number.isFinite(at(initial.createdAt)) || !Number.isFinite(at(initial.expiresAt)) ||
    !Number.isFinite(at(initial.observedAt)) || at(initial.createdAt)>seedEnd || at(initial.observedAt)>start || at(initial.observedAt)<seedEnd || at(initial.expiresAt)<at(initial.observedAt)) return fail('fixture_session_start_unproven');
  if(workload?.scope!=='candidate_lifecycle_observation' || workload.runId!==trial.runId || workload.state!=='present' ||
    !fingerprint.test(workload.sessionFingerprint || '') || workload.sessionFingerprint===initial.sessionFingerprint ||
    !Number.isFinite(at(workload.createdAt)) || !Number.isFinite(at(workload.expiresAt)) || !Number.isFinite(at(workload.observedAt)) ||
    at(workload.createdAt)>end || at(workload.expiresAt)<end || at(workload.observedAt)<end || at(workload.expiresAt)<at(workload.observedAt)) return fail('workload_session_unproven');
  if(after?.scope!=='candidate_lifecycle_observation' || after.runId!==prep.fixtureRunId || after.sessionFingerprint!==initial.sessionFingerprint ||
    !Number.isFinite(at(after.observedAt)) || at(after.observedAt)<end) return fail('fixture_session_followup_unproven');
  if(trial.scenario==='U6') {
    if(after.state!=='present' || at(initial.expiresAt)<end || !Number.isFinite(at(after.expiresAt)) || at(after.expiresAt)<at(after.observedAt)) return fail('other_session_not_proven_active');
  } else {
    if(prep.lifecycle?.state!=='not_found' || prep.lifecycle.sessionFingerprint!==initial.sessionFingerprint ||
      !Number.isFinite(at(prep.lifecycle.observedAt)) || at(prep.lifecycle.observedAt)<at(initial.observedAt) || at(prep.lifecycle.observedAt)>start || after.state!=='not_found') return fail('prior_session_retirement_unproven');
  }
  return {scope,valid:true,seedAudit:seedAudit.matches[0],fixtureSessionFingerprint:initial.sessionFingerprint,workloadSessionFingerprint:workload.sessionFingerprint};
}
