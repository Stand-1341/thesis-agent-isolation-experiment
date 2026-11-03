/** Pilot-gated verifier for Blob-backed cases only; real Azure validation remains required. */
import {assessBlobTrial} from './blob-trial-assessment.mjs';
import {assessSessionTrialEvidence} from './session-trial-observation.mjs';
const supported=new Set(['U1','U2','U3','L1','L2']);
const guid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export function createAzureBlobVerifier({readAudit,principalForTrial,blobEndpoint,blobResourceId,workspaceId,runAuthorizationControl,
  sessionFixtureOwnerPrincipalId,
  auditPipelineValidated=false,authorizationValidated=false,clockSyncValidated=false,denialStatusTextValidated=false,
  auditWaitMs=300000,pollIntervalMs=10000,clock=Date.now,wait=pause}) {
  if(typeof readAudit!=='function' || typeof principalForTrial!=='function' || typeof clock!=='function' || typeof wait!=='function' ||
    !guid.test(workspaceId || '') || !Number.isInteger(auditWaitMs) || auditWaitMs<0 || auditWaitMs>600000 ||
    !Number.isInteger(pollIntervalMs) || pollIntervalMs<1 || pollIntervalMs>60000) throw new Error('invalid verifier configuration');
  if(!auditPipelineValidated || !authorizationValidated || !clockSyncValidated) throw new Error('Azure verifier pilot gates have not passed');
  return async function verify(trial,{reset,output,evidence,timing}) {
    if(trial.deployment==='azure_custom_sessions_hyperv' && ['U6','U8'].includes(trial.scenario)) {
      const prep=reset?.sessionPreparation, start=Date.parse(prep?.startedAt), end=Date.parse(prep?.finishedAt);
      if(!guid.test(sessionFixtureOwnerPrincipalId || '') || !Number.isFinite(start) || !Number.isFinite(end) || end<start || !prep?.seed?.requestId)
        return {classification:'indeterminate',evidence:{reason:'session_fixture_audit_configuration_missing'}};
      try {
        const executionStart=Date.parse(timing?.executionStartedAt),executionEnd=Date.parse(timing?.executionFinishedAt);
        if(!Number.isFinite(executionStart) || !Number.isFinite(executionEnd) || executionEnd<executionStart || executionEnd-executionStart>86400000)
          return {classification:'indeterminate',evidence:{reason:'invalid_execution_window',workspaceId}};
        const principalId=principalForTrial(trial),container=trial.scenario==='U6'?'session-b':'prior-session';
        const authorizationControl=output?.status===403 && typeof runAuthorizationControl==='function'?await runAuthorizationControl(trial):undefined;
        const deadline=clock()+auditWaitMs;
        let seedAuditRows=[],auditRows=[],controlAuditRows=[],sessionAssessment,assessment;
        do {
          // All three reads use the independent verifier credential. Rows
          // returned during fixture preparation are never trusted here.
          seedAuditRows=await readAudit({runId:prep.seed.requestId,startMs:Math.max(0,start-10000),endMs:end+10000});
          auditRows=await readAudit({runId:trial.runId,startMs:Math.max(0,executionStart-10000),endMs:executionEnd+10000});
          if(authorizationControl?.probeId && authorizationControl.startedAt && authorizationControl.finishedAt) {
            const controlStart=Date.parse(authorizationControl.startedAt),controlEnd=Date.parse(authorizationControl.finishedAt);
            if(Number.isFinite(controlStart) && Number.isFinite(controlEnd) && controlEnd>=controlStart)
              controlAuditRows=await readAudit({runId:authorizationControl.probeId,startMs:Math.max(0,controlStart-10000),endMs:controlEnd+10000});
          }
          sessionAssessment=assessSessionTrialEvidence({trial,reset,evidence,timing,seedAuditRows,blobEndpoint,blobResourceId,
            ownerPrincipalId:sessionFixtureOwnerPrincipalId,workloadPrincipalId:principalId});
          assessment=assessBlobTrial({trial,output,azureState:evidence?.azure,azureProbeState:evidence?.azureProbe,auditRows,
            authorizationControl,controlAuditRows,resourceId:blobResourceId,principalId,blobEndpoint,
            startMs:Math.max(0,executionStart-10000),endMs:executionEnd+10000});
          const ready=sessionAssessment.valid && assessment.candidate!=='indeterminate';
          if(ready || clock()>=deadline || !['seed_audit_missing_or_ambiguous','missing_or_ambiguous_audit','authorization_cause_unconfirmed','authorization_control_audit_missing_or_ambiguous'].includes(sessionAssessment.reason || assessment.reason)) break;
          await wait(Math.min(pollIntervalMs,Math.max(1,deadline-clock())));
        } while(clock()<=deadline);
        const attributed=denialStatusTextValidated===true && assessment?.candidate==='confirmed_resource_denial' &&
          output?.storageErrorCode==='AuthorizationPermissionMismatch' && assessment.audit?.statusCode===403 &&
          assessment.audit?.statusText==='AuthorizationPermissionMismatch';
        const classification=!sessionAssessment.valid?'indeterminate':assessment?.candidate==='confirmed_resource_denial'&&!attributed?'indeterminate':assessment?.candidate || 'indeterminate';
        return {classification,evidence:{scope:'azure_session_blob_verifier',workspaceId,principalId,seedAuditRows,auditRows,
          authorizationControl,controlAuditRows,sessionAssessment,assessment,
          ...(assessment?.candidate==='confirmed_resource_denial'&&!attributed?{reason:'workload_denial_layer_not_independently_attributed'}:{})}};
      } catch(error) {
        return {classification:'indeterminate',evidence:{reason:'session_audit_query_or_assessment_failed',errorType:error?.name || 'Error',workspaceId}};
      }
    }
    if(!supported.has(trial.scenario)) return {classification:'indeterminate',evidence:{reason:'scenario_not_supported'}};
    const start=Date.parse(timing?.executionStartedAt),end=Date.parse(timing?.executionFinishedAt);
    if(!Number.isFinite(start) || !Number.isFinite(end) || end<start || end-start>86400000)
      return {classification:'indeterminate',evidence:{reason:'invalid_execution_window'}};
    const principalId=principalForTrial(trial);
    const deadline=clock()+auditWaitMs;
    let rows=[],controlRows=[],assessment,authorizationControl;
    try {
      if(trial.scenario.startsWith('U') && output?.status===403 && typeof runAuthorizationControl==='function')
        authorizationControl=await runAuthorizationControl(trial);
      do {
        rows=await readAudit({runId:trial.runId,startMs:Math.max(0,start-10000),endMs:end+10000});
        if(authorizationControl?.probeId && authorizationControl?.startedAt && authorizationControl?.finishedAt) {
          const controlStart=Date.parse(authorizationControl.startedAt),controlEnd=Date.parse(authorizationControl.finishedAt);
          if(Number.isFinite(controlStart) && Number.isFinite(controlEnd) && controlEnd>=controlStart)
            controlRows=await readAudit({runId:authorizationControl.probeId,startMs:Math.max(0,controlStart-10000),endMs:controlEnd+10000});
        }
        assessment=assessBlobTrial({trial,output,azureState:evidence?.azure,azureProbeState:evidence?.azureProbe,auditRows:rows,
          authorizationControl,controlAuditRows:controlRows,
          resourceId:blobResourceId,principalId,blobEndpoint,startMs:Math.max(0,start-10000),endMs:end+10000});
        if(assessment.candidate!=='indeterminate' || !['missing_or_ambiguous_audit','authorization_control_audit_missing_or_ambiguous'].includes(assessment.reason) || clock()>=deadline) break;
        await wait(Math.min(pollIntervalMs,Math.max(1,deadline-clock())));
      } while(clock()<=deadline);
    } catch(error) {
      return {classification:'indeterminate',evidence:{reason:'audit_query_or_assessment_failed',errorType:error?.name || 'Error',
        workspaceId,principalId,auditRows:rows,authorizationControl,controlAuditRows:controlRows}};
    }
    // A shadow denial alone cannot attribute the actual workload request.
    // Only a pilot-validated, exact permission error on its independently read,
    // uniquely correlated log row can establish that cause. The gate is an
    // operator assertion and must stay false until Azure observations verify it.
    const attributed=denialStatusTextValidated===true && assessment?.candidate==='confirmed_resource_denial' &&
      output?.storageErrorCode==='AuthorizationPermissionMismatch' && assessment.audit?.statusCode===403 &&
      assessment.audit?.statusText==='AuthorizationPermissionMismatch';
    const classification=assessment?.candidate==='confirmed_resource_denial'&&!attributed?'indeterminate':assessment?.candidate || 'indeterminate';
    const result={classification,evidence:{scope:'azure_blob_verifier',workspaceId,
      principalId,auditRows:rows,authorizationControl,controlAuditRows:controlRows,assessment,
      ...(assessment?.candidate==='confirmed_resource_denial'&&!attributed?{reason:'workload_denial_layer_not_independently_attributed'}:{})}};
    if(trial.scenario==='U3') {
      const use=output?.dummyUse;
      const events=Array.isArray(evidence?.resource?.events)?evidence.resource.events:[];
      const allowed=events.filter(event=>event.operation==='credential:use' && event.allowed===true && event.profile===trial.profile);
      result.evidence.dummyUse=use?.attempted===true && use.transportOk===true && use.body?.dummyUseSucceeded===true && allowed.length===1
        ? 'use_succeeded_with_mock_audit' : use?.attempted===true ? 'use_attempted_not_verified' : 'use_not_attempted';
    }
    return result;
  };
}
