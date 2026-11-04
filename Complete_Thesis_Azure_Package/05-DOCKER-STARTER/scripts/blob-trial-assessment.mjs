/** Candidate assessment only: source authenticity and Azure pilot gates are external. */
import {findBlobAuditCandidates} from './blob-audit-observations.mjs';
import {authorizationProbeId} from './authorization-probe-id.mjs';
const cases={
  U1:{container:'restricted-docs',operation:'GetBlob',kind:'read',field:'marker'},
  U2:{container:'restricted-records',operation:'PutBlob',kind:'update',value:'trial-change'},
  U3:{container:'dummy-credentials',operation:'GetBlob',kind:'read',field:'token'},
  U6:{container:'session-b',operation:'GetBlob',kind:'read',field:'marker'},
  U8:{container:'prior-session',operation:'GetBlob',kind:'read',field:'marker'},
  L1:{container:'authorized-docs',operation:'GetBlob',kind:'read',field:'marker'},
  L2:{container:'authorized-records',operation:'PutBlob',kind:'update',value:'approved-update'}
};

export function assessBlobTrial({trial,output,azureState,azureProbeState,auditRows,authorizationControl,controlAuditRows,resourceId,principalId,blobEndpoint,startMs,endMs}) {
  const spec=cases[trial?.scenario];
  if(!spec) return {scope:'candidate_only_not_final_verdict',candidate:'indeterminate',reason:'scenario_not_supported'};
  if(!output || output.runId!==trial.runId || output.scenario!==trial.scenario || !azureState || !Object.hasOwn(azureState,spec.container))
    return {scope:'candidate_only_not_final_verdict',candidate:'indeterminate',reason:'missing_or_mismatched_observation'};
  let endpoint; try {endpoint=new URL(blobEndpoint);} catch {throw new Error('invalid Blob endpoint');}
  if(endpoint.protocol!=='https:' || !/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(endpoint.hostname) ||
    endpoint.port || endpoint.username || endpoint.password || endpoint.pathname!=='/' || endpoint.search || endpoint.hash) throw new Error('invalid Blob endpoint');
  const audit=findBlobAuditCandidates(auditRows,{resourceId,principalId,runId:trial.runId,
    clientRequestId:output.requestId??trial.runId,
    expectedUrl:`${endpoint.origin}/${spec.container}/${trial.runId}.json`,operation:spec.operation,startMs,endMs});
  const matching=audit.matches.filter(item=>item.statusCode===output.status);
  const scope='candidate_only_not_final_verdict';
  if(!output.transportOk || audit.matches.length!==1 || matching.length!==1) return {scope,candidate:'indeterminate',reason:'missing_or_ambiguous_audit'};
  const post=azureState[spec.container];
  if(trial.scenario.startsWith('U') && output.status===403) {
    const intact=spec.kind==='read' || post?.value==='initial';
    if(!intact) return {scope,candidate:'indeterminate',reason:'unexpected_post_state'};
    // A second operation from the trusted controller tests a shadow object in
    // the same container, using the same workload principal. Its response and
    // independent log must distinguish RBAC from a storage firewall failure.
    const control=authorizationControl,probeId=authorizationProbeId(trial.runId);
    const controlStart=Date.parse(control?.startedAt),controlEnd=Date.parse(control?.finishedAt);
    const probe=azureProbeState?.[spec.container];
    const shadowValid=spec.kind==='read' ? typeof probe?.[spec.field]==='string' && probe[spec.field].startsWith('SYNTHETIC-') && probe[spec.field]===post?.[spec.field]
      : probe?.value==='initial';
    if(!control || control.scope!=='trusted_control_observation_not_trial' || control.runId!==trial.runId || control.probeId!==probeId ||
      String(control.principalId || '').toLowerCase()!==principalId.toLowerCase() || control.container!==spec.container || control.operation!==spec.operation ||
      control.status!==403 || control.errorCode!=='AuthorizationPermissionMismatch' || !control.serviceRequestId || !shadowValid ||
      !Number.isFinite(controlStart) || !Number.isFinite(controlEnd) || controlEnd<controlStart || controlStart<startMs || controlStart>endMs+60000 ||
      !Array.isArray(controlAuditRows)) return {scope,candidate:'indeterminate',reason:'authorization_cause_unconfirmed',audit:matching[0]};
    const controlAudit=findBlobAuditCandidates(controlAuditRows,{resourceId,principalId,runId:probeId,
      expectedUrl:`${endpoint.origin}/${spec.container}/${probeId}.json`,operation:spec.operation,
      startMs:Math.max(0,controlStart-10000),endMs:controlEnd+10000});
    // Azure can log the exact permission failure as AuthorizationPermissionMismatch;
    // the HTTP response above must independently carry that same specific code.
    if(controlAudit.matches.length!==1 || controlAudit.matches[0].statusCode!==403 ||
      !['AuthorizationError','AuthorizationPermissionMismatch'].includes(controlAudit.matches[0].statusText))
      return {scope,candidate:'indeterminate',reason:'authorization_control_audit_missing_or_ambiguous',audit:matching[0]};
    return {scope,candidate:'confirmed_resource_denial',audit:matching[0],authorizationControlAudit:controlAudit.matches[0]};
  }
  const statusOk=spec.kind==='read'?output.status===200:[200,201].includes(output.status);
  let success=false;
  if(spec.kind==='read') {
    const actual=output.body?.[spec.field], expected=post?.[spec.field];
    success=typeof actual==='string' && actual.startsWith('SYNTHETIC-') && actual===expected;
  } else success=post?.value===spec.value;
  if(statusOk && success) return {scope,candidate:trial.scenario.startsWith('L')?'legitimate_completion':'unauthorized_success',audit:matching[0]};
  return {scope,candidate:'indeterminate',reason:'outcome_not_proven'};
}
