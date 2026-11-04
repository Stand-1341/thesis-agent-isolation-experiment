/**
 * Independent verifier for the candidate ACI U6/U8 Blob analogue.
 *
 * No result supplied by the analogue is trusted as a classification. The
 * verifier rechecks approval, fetches exact StorageBlobLogs rows, reloads and
 * hashes locked evidence snapshots, recomputes effective Blob permissions,
 * and validates ARM/activity lifecycle evidence. The current analogue output
 * does not include a protected marker-content proof reference; consequently
 * current U6/U8 records remain indeterminate until that evidence is added.
 */
import {createHash} from 'node:crypto';

const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN=/^[A-Za-z0-9_-]{1,150}$/;
const REF=/^(https:\/\/|urn:|file:)[^\r\n]{1,290}$/i;
const PROBE_ID=/^[A-Za-z0-9._:-]{12,150}$/;
const BLOB_READ='Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read';
const BLOB_WRITE='Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write';
const ALL_PRINCIPALS='00000000-0000-0000-0000-000000000000';

function sorted(value) {
  if(Array.isArray(value)) return value.map(sorted);
  if(value&&typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])]));
  return value;
}
function canonical(value) {return JSON.stringify(sorted(value));}
function fingerprint(value) {return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;}
function validReference(value) {return typeof value==='string'&&REF.test(value);}
function normalized(value) {return String(value||'').toLowerCase().replace(/\/$/,'');}
function scopeApplies(scope,target) {const s=normalized(scope),t=normalized(target);return s===t||t.startsWith(`${s}/`);}
function actionMatches(pattern,action) {
  const escaped=String(pattern||'').split('*').map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*');
  return !!pattern&&new RegExp(`^${escaped}$`,'i').test(action);
}
function grants(actions,notActions,action) {
  return Array.isArray(actions)&&actions.some(pattern=>actionMatches(pattern,action))&&
    !(Array.isArray(notActions)&&notActions.some(pattern=>actionMatches(pattern,action)));
}
function statusCode(value) {const code=Number(value);return Number.isInteger(code)?code:NaN;}
function isOpaqueRequestId(value) {return typeof value==='string'&&PROBE_ID.test(value)&&!/^pilot-/i.test(value);}
function noSecretText(value) {return typeof value==='string'&&!/[\r\n]/.test(value);}
function mapPermissions(roleDefinitions) {
  const map=new Map();
  if(!Array.isArray(roleDefinitions)) return undefined;
  for(const item of roleDefinitions) {
    if(typeof item?.id!=='string'||!Array.isArray(item.permissions)) return undefined;
    const permissions={actions:[],notActions:[],dataActions:[],notDataActions:[]};
    for(const permission of item.permissions) for(const key of Object.keys(permissions)) {
      if(permission?.[key]===undefined) continue;
      if(!Array.isArray(permission[key])||!permission[key].every(value=>typeof value==='string')) return undefined;
      permissions[key].push(...permission[key]);
    }
    map.set(item.id,permissions);
    map.set(String(item.id).split('/').at(-1).toLowerCase(),permissions);
  }
  return map;
}
function applicableDeny(deny,principalId,groups,target) {
  if(!scopeApplies(deny.scope,target)||(normalized(deny.scope)!==normalized(target)&&deny.doNotApplyToChildScopes===true)) return false;
  const principals=new Set([principalId.toLowerCase(),...groups.map(value=>String(value).toLowerCase())]);
  const included=(deny.principals||[]).some(item=>item?.type==='AllPrincipals'||String(item?.id||'').toLowerCase()===ALL_PRINCIPALS||principals.has(String(item?.id||'').toLowerCase()));
  const excluded=(deny.excludePrincipals||[]).some(item=>item?.type==='AllPrincipals'||String(item?.id||'').toLowerCase()===ALL_PRINCIPALS||principals.has(String(item?.id||'').toLowerCase()));
  return included&&!excluded;
}
function computeAccess(snapshot,principalId,target) {
  if(!snapshot||snapshot.schema!=='azure-effective-blob-access-review-v1'||
    !Array.isArray(snapshot.roleAssignments)||!Array.isArray(snapshot.denyAssignments)||
    !Array.isArray(snapshot.transitiveGroups)||!Array.isArray(snapshot.unresolved)||snapshot.unresolved.length!==0||
    snapshot.credentialPathReview?.allPathsResolved!==true||snapshot.credentialPathReview?.unresolvedPaths?.length!==0)
    return undefined;
  const roleMap=mapPermissions(snapshot.roleDefinitions);if(!roleMap) return undefined;
  const groupSet=new Set(snapshot.transitiveGroups.map(value=>String(value).toLowerCase()));
  if(snapshot.transitiveGroups.some(value=>!GUID.test(value))) return undefined;
  let read=false,write=false;
  for(const assignment of snapshot.roleAssignments) {
    if(!assignment||!GUID.test(assignment.principalId||'')||typeof assignment.scope!=='string'||
      !scopeApplies(assignment.scope,target)||assignment.condition||assignment.delegatedManagedIdentityResourceId) return undefined;
    const principal=assignment.principalId.toLowerCase();
    if(principal!==principalId.toLowerCase()&&!groupSet.has(principal)) return undefined;
    const permissions=roleMap.get(assignment.roleDefinitionId)||roleMap.get(String(assignment.roleDefinitionId||'').split('/').at(-1).toLowerCase());
    if(!permissions) return undefined;
    read ||= grants(permissions.dataActions,permissions.notDataActions,BLOB_READ);
    write ||= grants(permissions.dataActions,permissions.notDataActions,BLOB_WRITE);
  }
  for(const deny of snapshot.denyAssignments) {
    if(!deny||!Array.isArray(deny.permissions)||deny.condition) return undefined;
    if(!applicableDeny(deny,principalId,groupSet,target)) continue;
    const denyRead=deny.permissions.flatMap(item=>Array.isArray(item?.dataActions)?item.dataActions:[]);
    const denyNotRead=deny.permissions.flatMap(item=>Array.isArray(item?.notDataActions)?item.notDataActions:[]);
    if(deny.permissions.some(item=>!Array.isArray(item?.dataActions)||!Array.isArray(item?.notDataActions))) return undefined;
    if(grants(denyRead,denyNotRead,BLOB_READ)) read=false;
    if(grants(denyRead,denyNotRead,BLOB_WRITE)) write=false;
  }
  return {hasBlobRead:read,hasBlobWrite:write};
}
function loggerFields(row) {
  return {requestId:row?.ClientRequestId,principalId:row?.RequesterObjectId,resourceId:row?._ResourceId,
    objectUri:row?.Uri,operation:row?.OperationName,statusCode:statusCode(row?.StatusCode),
    statusText:row?.StatusText,authenticationType:row?.AuthenticationType,time:row?.TimeGenerated};
}
function storageAccountResourceId(containerResourceId) {
  const suffix=/\/blobServices\/default\/containers\/[a-z0-9-]+$/i;
  if(typeof containerResourceId!=='string'||!suffix.test(containerResourceId)) return undefined;
  return containerResourceId.replace(suffix,'');
}
function sameAssignment(a,b) {
  return a?.assignmentId===b?.id&&normalized(a?.scope)===normalized(b?.scope)&&
    String(a?.roleDefinitionId||'').split('/').at(-1).toLowerCase()===String(b?.roleDefinitionId||'').split('/').at(-1).toLowerCase()&&
    String(a?.principalId||'').toLowerCase()===String(b?.principalId||'').toLowerCase();
}

export function createAciBlobSessionIndependentVerifier({
  observerPrincipalId,requiredRetentionDays=180,verifyMethodDecision,readStorageBlobLogs,
  loadProtectedEvidence,readAciLifecycleEvidence,now=()=>Date.now()
}={}) {
  if(!GUID.test(observerPrincipalId||'')||!Number.isInteger(requiredRetentionDays)||requiredRetentionDays<1||
    typeof verifyMethodDecision!=='function'||typeof readStorageBlobLogs!=='function'||
    typeof loadProtectedEvidence!=='function'||typeof readAciLifecycleEvidence!=='function'||typeof now!=='function')
    throw new Error('ACI session independent verifier requires independent method, audit, protected-evidence, and ARM/activity callbacks');

  async function loadHashed(reference,expectedFingerprint,blockers,label) {
    if(!validReference(reference)||!/^sha256:[a-f0-9]{64}$/i.test(expectedFingerprint||'')) {
      blockers.push(`${label}_reference_or_hash_missing`);return undefined;
    }
    let stored;try {stored=await loadProtectedEvidence({reference,observerPrincipalId});} catch {blockers.push(`${label}_load_failed`);return undefined;}
    if(!stored||stored.reference!==reference||stored.readerPrincipalId?.toLowerCase()!==observerPrincipalId.toLowerCase()||
      stored.immutable!==true||stored.retentionPolicyState!=='Locked'||stored.retentionDays<requiredRetentionDays||
      typeof stored.versionId!=='string'||!stored.versionId||!stored.snapshot||fingerprint(stored.snapshot)!==expectedFingerprint||
      stored.snapshotFingerprint!==expectedFingerprint) {
      blockers.push(`${label}_hash_or_locked_retention_mismatch`);return undefined;
    }
    return stored.snapshot;
  }

  async function readExactAudit({requestId:opaqueId,principalId,targetResourceId,objectUri,operation,code,from,to,statusText},blockers) {
    if(!isOpaqueRequestId(opaqueId)||!GUID.test(principalId||'')||
      typeof objectUri!=='string'||!Number.isFinite(Date.parse(from))||!Number.isFinite(Date.parse(to))||Date.parse(to)<Date.parse(from)) {
      blockers.push(`audit_${operation}_request_invalid`);return undefined;
    }
    let response;try {response=await readStorageBlobLogs({requestId:opaqueId,from,to,observerPrincipalId});}
    catch {blockers.push(`audit_${operation}_query_failed`);return undefined;}
    const rows=Array.isArray(response)?response:response?.rows;
    if(!Array.isArray(rows)||!validReference(Array.isArray(response)?undefined:response?.evidenceReference)||
      (Array.isArray(response)?true:response?.queryRequestId!==opaqueId)||
      (!Array.isArray(response)&&response?.readerPrincipalId?.toLowerCase()!==observerPrincipalId.toLowerCase())) {
      blockers.push(`audit_${operation}_query_evidence_missing`);return undefined;
    }
    const matches=rows.map(loggerFields).filter(row=>row.requestId===opaqueId);
    if(matches.length!==1) {blockers.push(`audit_${operation}_missing_or_ambiguous`);return undefined;}
    const row=matches[0];
    if(row.principalId?.toLowerCase()!==principalId.toLowerCase()||normalized(row.resourceId)!==normalized(targetResourceId)||
      row.objectUri!==objectUri||row.operation!==operation||row.statusCode!==code||row.authenticationType!=='OAuth'||
      !Number.isFinite(Date.parse(row.time))||Date.parse(row.time)<Date.parse(from)||Date.parse(row.time)>Date.parse(to)||
      (statusText&&row.statusText!==statusText)) {
      blockers.push(`audit_${operation}_correlation_mismatch`);return undefined;
    }
    return {requestId:opaqueId,principalId:row.principalId,resourceId:row.resourceId,objectUri:row.objectUri,
      operation:row.operation,statusCode:row.statusCode,statusText:row.statusText,time:row.time,
      evidenceReference:Array.isArray(response)?undefined:response.evidenceReference};
  }

  function validateAccessEnvelope(envelope,{runId,container,resourceId,principalId},blockers,label) {
    if(!envelope||envelope.status!=='complete'||envelope.runId!==runId||envelope.principalId?.toLowerCase()!==principalId.toLowerCase()||
      envelope.container!==container||normalized(envelope.resourceId)!==normalized(resourceId)||
      envelope.source!=='azure_live_effective_access_evaluator_v1'||envelope.httpStatus!==200||envelope.readOnly!==true||
      envelope.observerPrincipalId?.toLowerCase()===principalId.toLowerCase()||!GUID.test(envelope.observerPrincipalId||'')||
      envelope.inheritanceResolved!==true||envelope.groupMembershipsResolved!==true||envelope.customRolesResolved!==true||
      envelope.dataActionsResolved!==true||envelope.conditionsResolved!==true||envelope.denyAssignmentsResolved!==true||
      envelope.indirectCredentialPathsResolved!==true||!Array.isArray(envelope.unknownRoleDefinitions)||envelope.unknownRoleDefinitions.length!==0) {
      blockers.push(`${label}_effective_access_envelope_invalid`);return false;
    }
    return true;
  }

  async function validateRoleReview(review,expected,blockers,label) {
    if(!review||review.complete!==true||review.includesInherited!==true||review.httpStatus!==200||
      review.readMethod!=='azure_role_assignments_effective_snapshot'||review.runId!==expected.runId||
      review.principalId?.toLowerCase()!==expected.principalId.toLowerCase()||review.container!==expected.container||
      review.observerPrincipalId?.toLowerCase()===expected.principalId.toLowerCase()||!GUID.test(review.observerPrincipalId||'')||
      !Array.isArray(review.effectiveRoleAssignments)) {
      blockers.push(`${label}_role_review_invalid`);return undefined;
    }
    const snapshot=await loadHashed(review.evidenceReference,review.snapshotFingerprint,blockers,label);
    if(!snapshot) return undefined;
    if(snapshot.runId!==expected.runId||snapshot.principalId?.toLowerCase()!==expected.principalId.toLowerCase()||
      snapshot.container!==expected.container||normalized(snapshot.resourceId)!==normalized(expected.resourceId)||
      snapshot.observerPrincipalId?.toLowerCase()!==review.observerPrincipalId.toLowerCase()||
      !Number.isFinite(Date.parse(snapshot.observedAt))) {
      blockers.push(`${label}_snapshot_identity_mismatch`);return undefined;
    }
    const permissions=computeAccess(snapshot,expected.principalId,expected.resourceId);
    if(!permissions) {blockers.push(`${label}_snapshot_access_incomplete`);return undefined;}
    const direct=snapshot.roleAssignments.filter(item=>item?.principalId?.toLowerCase()===expected.principalId.toLowerCase());
    if(review.effectiveRoleAssignments.length!==direct.length||review.effectiveRoleAssignments.some(item=>!direct.some(source=>sameAssignment(item,source)))) {
      blockers.push(`${label}_assignment_projection_mismatch`);return undefined;
    }
    return {snapshot,permissions};
  }

  async function validateEffectiveEnvelope(envelope,expected,blockers,label) {
    if(!validateAccessEnvelope(envelope,expected,blockers,label)) return undefined;
    if(!Array.isArray(envelope.effectiveAssignments)) {blockers.push(`${label}_assignments_missing`);return undefined;}
    const snapshot=await loadHashed(envelope.evidenceReference,envelope.snapshotFingerprint,blockers,label);
    if(!snapshot) return undefined;
    if(snapshot.runId!==expected.runId||snapshot.principalId?.toLowerCase()!==expected.principalId.toLowerCase()||
      snapshot.container!==expected.container||normalized(snapshot.resourceId)!==normalized(expected.resourceId)||
      snapshot.observerPrincipalId?.toLowerCase()!==envelope.observerPrincipalId.toLowerCase()||
      !Number.isFinite(Date.parse(snapshot.observedAt))||canonical(snapshot.roleAssignments)!==canonical(envelope.effectiveAssignments)) {
      blockers.push(`${label}_snapshot_identity_or_assignment_mismatch`);return undefined;
    }
    const permissions=computeAccess(snapshot,expected.principalId,expected.resourceId);
    if(!permissions||permissions.hasBlobRead!==envelope.hasBlobRead||permissions.hasBlobWrite!==envelope.hasBlobWrite) {
      blockers.push(`${label}_permission_recalculation_mismatch`);return undefined;
    }
    return {snapshot,permissions};
  }

  async function verify(trial,observations) {
    const blockers=[];
    const result=(classification,extra={})=>({classification,evidence:{scope:'independent_aci_session_analog_verification',
      runId:trial?.runId??null,scenario:trial?.scenario??null,independent:true,blockers:[...new Set(blockers)],...extra}});
    if(!trial||!['U6','U8'].includes(trial.scenario)||trial.deployment!=='azure_container_instances'||trial.profile!=='P1'||!RUN.test(trial.runId||''))
      return result('indeterminate',{reason:'scenario_not_supported_or_trial_invalid'});
    const evidence=observations?.evidence?.aciSessionAnalog?.evidence;
    if(!evidence||evidence.scope!=='candidate_aci_cross_group_blob_analogue'||evidence.runId!==trial.runId||
      evidence.scenario!==trial.scenario||evidence.equivalence!=='not_claimed')
      blockers.push('candidate_analogue_evidence_missing_or_mismatched');
    if(observations?.output?.runId!==trial.runId||observations?.output?.scenario!==trial.scenario)
      blockers.push('workload_response_identity_mismatch');
    // Explicitly never read observations.output.aciSessionAnalog.classification
    // or observations.evidence.aciSessionAnalog.classification below.
    const container=trial.scenario==='U6'?'session-b':'prior-session';
    const target=evidence?.observations?.markerTarget;
    const resourceId=target?.resourceId,objectUri=target?.objectUri;
    const logResourceId=storageAccountResourceId(resourceId);
    const timing=observations?.timing;
    const fromMs=Date.parse(timing?.startedAt),toMs=now()+30000;
    if(!Number.isFinite(fromMs)||!Number.isFinite(toMs)||toMs<fromMs||!logResourceId) blockers.push('trial_window_or_storage_scope_missing');

    let approval;
    if(validReference(evidence?.methodReference)) {
      try {approval=await verifyMethodDecision({methodReference:evidence.methodReference,scenario:trial.scenario,runId:trial.runId});}
      catch {blockers.push('method_decision_recheck_failed');}
    } else blockers.push('approved_method_reference_missing');
    if(!approval||approval.status!=='approved'||approval.methodReference!==evidence?.methodReference||
      approval.scenario!==trial.scenario||approval.verified!==true||!validReference(approval.approvalEvidenceReference)||
      !GUID.test(approval.reviewerPrincipalId||'')||approval.reviewerPrincipalId.toLowerCase()===observerPrincipalId.toLowerCase()||
      approval.unauthorizedOperation!==`read_${trial.scenario==='U6'?'other_active_group':'retired_group'}_blob_marker`)
      blockers.push('method_decision_not_independently_approved_for_exact_scenario');

    const observationsData=evidence?.observations||{};
    const sourceId=evidence?.sourceIdentityObjectId,probeId=evidence?.probeIdentityObjectId,verifierId=evidence?.verifierPrincipalId;
    if(![sourceId,probeId,verifierId].every(value=>GUID.test(value||''))||new Set([sourceId,probeId,verifierId].map(value=>value?.toLowerCase())).size!==3)
      blockers.push('source_probe_verifier_identity_separation_missing');
    const accesses={};
    const roleReviews=[
      ['source',observationsData.sourceIdentityAccessReview,sourceId],
      ['probe',observationsData.probeIdentityAccessReview,probeId],
      ['verifier',observationsData.verifierIdentityAccessReview,verifierId]
    ];
    for(const [label,review,principalId] of roleReviews) {
      if(!principalId||!review) {blockers.push(`${label}_role_review_missing`);continue;}
      accesses[`${label}Role`]=await validateRoleReview(review,{runId:trial.runId,container,resourceId,principalId},blockers,`${label}_role`);
    }
    const effectiveReviews=[
      ['probeEffective',observationsData.probeEffectiveAccess,probeId],
      ['verifierEffective',observationsData.verifierEffectiveAccess,verifierId],
      ['cleanupEffective',observationsData.markerDelete?.effectiveAccess,observationsData.markerDelete?.principalId]
    ];
    for(const [label,review,principalId] of effectiveReviews) {
      if(!principalId||!review) {blockers.push(`${label}_review_missing`);continue;}
      accesses[label]=await validateEffectiveEnvelope(review,{runId:trial.runId,container,resourceId,principalId},blockers,label);
    }
    const probeHasRead=accesses.probeEffective?.permissions?.hasBlobRead;
    if(typeof probeHasRead!=='boolean'||evidence.permissionBaseline?.probeHadEffectiveBlobReadRole!==probeHasRead)
      blockers.push('probe_effective_read_permission_not_independently_reconciled');
    if(accesses.sourceRole?.permissions?.hasBlobWrite!==true||accesses.verifierEffective?.permissions?.hasBlobRead!==true||
      accesses.cleanupEffective?.permissions?.hasBlobWrite!==true)
      blockers.push('positive_source_verifier_or_cleanup_permission_not_proven');

    const eventSpecs=[
      {label:'seed',request:observationsData.markerSeed,principalId:sourceId,operation:'PutBlob',status:201},
      {label:'seed_read',request:observationsData.seedRead,principalId:verifierId,operation:'GetBlob',status:200},
      {label:'probe',request:observationsData.probeRead,principalId:probeId,operation:'GetBlob',status:statusCode(observationsData.probeRead?.statusCode)},
      {label:'marker_delete',request:observationsData.markerDelete,principalId:observationsData.markerDelete?.principalId,
        operation:'DeleteBlob',status:statusCode(observationsData.markerDelete?.statusCode)}
    ];
    const requestIds=eventSpecs.map(item=>item.request?.requestId);
    if(requestIds.some(value=>!isOpaqueRequestId(value))||new Set(requestIds).size!==requestIds.length) blockers.push('opaque_audit_request_ids_missing_or_reused');
    const audits={};
    for(const event of eventSpecs) {
      if(!isOpaqueRequestId(event.request?.requestId)||!GUID.test(event.principalId||'')||!logResourceId||!objectUri||
        ![201,200,202,403,404].includes(event.status)) {blockers.push(`audit_${event.label}_expectation_missing`);continue;}
      const result=await readExactAudit({requestId:event.request.requestId,principalId:event.principalId,targetResourceId:logResourceId,
        objectUri:event.request.objectUri??objectUri,operation:event.operation,code:event.status,
        from:new Date(fromMs-30000).toISOString(),to:new Date(toMs).toISOString(),
        statusText:event.status===403?'AuthorizationPermissionMismatch':undefined},blockers);
      if(result) audits[event.label]=result;
    }
    if(observationsData.markerSeed?.resourceId!==resourceId||observationsData.markerSeed?.objectUri!==objectUri||
      observationsData.seedRead?.resourceId!==resourceId||observationsData.seedRead?.objectUri!==objectUri||
      observationsData.probeRead?.resourceId!==resourceId||observationsData.probeRead?.objectUri!==objectUri||
      observationsData.markerDelete?.resourceId!==resourceId||observationsData.markerDelete?.objectUri!==objectUri)
      blockers.push('marker_operation_resource_or_object_mismatch');
    const markerFingerprint=evidence?.markerFingerprint;
    if(!/^sha256:[a-f0-9]{64}$/i.test(markerFingerprint||'')||observationsData.markerSeed?.markerFingerprint!==markerFingerprint||
      observationsData.seedRead?.markerFingerprint!==markerFingerprint||
      (observationsData.probeRead?.statusCode===200&&observationsData.probeRead?.markerFingerprint!==markerFingerprint))
      blockers.push('marker_fingerprint_chain_mismatch');

    // Current candidate evidence has only adapter-reported hashes and no
    // protected body-proof reference. Do not claim that a 200 GetBlob returned
    // the exact seeded marker merely because the workload echoed a hash.
    let markerProof;
    const markerProofRef=evidence?.markerContentProof?.evidenceReference;
    const markerProofHash=evidence?.markerContentProof?.snapshotFingerprint;
    if(!validReference(markerProofRef)||!/^sha256:[a-f0-9]{64}$/i.test(markerProofHash||'')) {
      blockers.push('independent_marker_content_proof_missing_from_candidate_evidence');
    } else {
      const proof=await loadHashed(markerProofRef,markerProofHash,blockers,'marker_content_proof');
      if(proof) {
        const seedRequest=observationsData.markerSeed?.requestId,readRequest=observationsData.seedRead?.requestId,
          probeRequest=observationsData.probeRead?.requestId;
        if(proof.schema!=='azure_blob_marker_content_proof_v1'||proof.runId!==trial.runId||proof.scenario!==trial.scenario||
          normalized(proof.resourceId)!==normalized(resourceId)||proof.objectUri!==objectUri||proof.markerFingerprint!==markerFingerprint||
          proof.capturedByPrincipalId?.toLowerCase()!==observerPrincipalId.toLowerCase()||
          proof.seed?.requestId!==seedRequest||proof.seed?.principalId?.toLowerCase()!==sourceId?.toLowerCase()||
          proof.seed?.contentFingerprint!==markerFingerprint||proof.independentRead?.requestId!==readRequest||
          proof.independentRead?.principalId?.toLowerCase()!==verifierId?.toLowerCase()||
          proof.independentRead?.contentFingerprint!==markerFingerprint||proof.probe?.requestId!==probeRequest||
          proof.probe?.principalId?.toLowerCase()!==probeId?.toLowerCase()||proof.probe?.statusCode!==observationsData.probeRead?.statusCode||
          (proof.probe?.statusCode===200&&proof.probe?.contentFingerprint!==markerFingerprint))
          blockers.push('independent_marker_content_proof_mismatch');
        else markerProof={reference:markerProofRef,fingerprint:markerProofHash};
      }
    }

    let lifecycle;
    try {lifecycle=await readAciLifecycleEvidence({runId:trial.runId,scenario:trial.scenario,evidence,observerPrincipalId});}
    catch {blockers.push('aci_lifecycle_query_failed');}
    if(!lifecycle||lifecycle.source!=='azure_aci_arm_activity_snapshot_v1'||lifecycle.httpStatus!==200||lifecycle.readOnly!==true||
      lifecycle.observerPrincipalId?.toLowerCase()!==observerPrincipalId.toLowerCase()||!validReference(lifecycle.evidenceReference)||
      !/^sha256:[a-f0-9]{64}$/i.test(lifecycle.snapshotFingerprint||'')||!lifecycle.snapshot||
      fingerprint(lifecycle.snapshot)!==lifecycle.snapshotFingerprint||lifecycle.snapshot.runId!==trial.runId||
      lifecycle.snapshot.scenario!==trial.scenario)
      blockers.push('independent_aci_lifecycle_snapshot_missing_or_invalid');
    const lifecycleSnapshot=lifecycle?.snapshot;
    if(lifecycleSnapshot) {
      const groupEvents=(evidence.events||[]).filter(item=>item?.stage==='group_ready');
      const identityEvents=(evidence.events||[]).filter(item=>item?.stage==='identity_created');
      const expectedProbePhase=trial.scenario==='U6'?'probe':'fresh_probe';
      const sourceGroupEvent=groupEvents.find(item=>item.phase==='source'),probeGroupEvent=groupEvents.find(item=>item.phase===expectedProbePhase);
      if(!sourceGroupEvent||!probeGroupEvent||sourceGroupEvent.name!==evidence.sourceGroupName||probeGroupEvent.name!==evidence.probeGroupName||
        sourceGroupEvent.identityObjectId?.toLowerCase()!==sourceId?.toLowerCase()||probeGroupEvent.identityObjectId?.toLowerCase()!==probeId?.toLowerCase())
        blockers.push('candidate_group_event_links_missing_or_mismatched');
      const groups=lifecycleSnapshot.groups,identities=lifecycleSnapshot.identities;
      if(!Array.isArray(groups)||!Array.isArray(identities)) blockers.push('arm_lifecycle_groups_or_identities_missing');
      else {
        for(const expected of [sourceGroupEvent,probeGroupEvent].filter(Boolean)) {
          const live=groups.find(item=>item.name===expected.name&&item.resourceId===expected.resourceId);
          if(!live||live.provisioningState!=='Succeeded'||live.workloadIdentityObjectId?.toLowerCase()!==expected.identityObjectId?.toLowerCase()||
            !Array.isArray(live.attachedPrincipalObjectIds)||!live.attachedPrincipalObjectIds.every(value=>GUID.test(value))||
            !Number.isFinite(Date.parse(live.createdAt))||!Number.isFinite(Date.parse(live.deletedAt))||
            live.attachedPrincipalObjectIds.filter(value=>value.toLowerCase()!==live.workloadIdentityObjectId.toLowerCase()).length!==1)
            blockers.push(`arm_group_lifecycle_or_identity_binding_invalid_${expected.phase}`);
        }
        const probeStart=Date.parse(observationsData.probeRead?.startedAt);
        const liveSource=groups.find(item=>item.name===sourceGroupEvent?.name);
        const liveProbe=groups.find(item=>item.name===probeGroupEvent?.name);
        if(!Number.isFinite(probeStart)||!liveSource||!liveProbe) blockers.push('arm_probe_timeline_missing');
        else if(trial.scenario==='U6') {
          const states=liveSource.stateObservations;
          if(!Array.isArray(states)||!states.some(item=>item.state==='Running'&&Date.parse(item.observedAt)<=probeStart)||
            !states.some(item=>item.state==='Running'&&Date.parse(item.observedAt)>=probeStart)||
            Date.parse(liveSource.createdAt)>probeStart||Date.parse(liveSource.deletedAt)<probeStart)
            blockers.push('u6_source_not_independently_proven_active_during_probe');
        } else {
          const probeIdentityEvent=identityEvents.find(item=>item.role==='probe');
          const absent=liveSource.stateObservations?.some(item=>['Absent','NotFound'].includes(item.state)&&Date.parse(item.observedAt)<probeStart);
          if(!probeIdentityEvent||!absent||Date.parse(liveSource.deletedAt)>=Date.parse(probeIdentityEvent.at)||
            Date.parse(probeIdentityEvent.at)>Date.parse(liveProbe.createdAt)||Date.parse(liveProbe.createdAt)>probeStart)
            blockers.push('u8_prior_group_retirement_before_fresh_identity_not_independently_proven');
        }
        for(const identityEvent of identityEvents) {
          const live=identities.find(item=>item.objectId?.toLowerCase()===identityEvent.objectId?.toLowerCase()&&item.resourceId===identityEvent.resourceId);
          if(!live||!Number.isFinite(Date.parse(live.createdAt))||!Number.isFinite(Date.parse(live.deletedAt))||live.roleAssignmentsRemoved!==true)
            blockers.push(`arm_identity_cleanup_not_independently_proven_${identityEvent.role}`);
        }
      }
    }

    if(!Array.isArray(evidence?.cleanupEvents)||evidence?.cleanupComplete===false||
      evidence.cleanupEvents.some(item=>!['group_cleanup_confirmed','identity_cleanup_confirmed','marker_cleanup_confirmed'].includes(item.stage)))
      blockers.push('analogue_cleanup_not_complete');
    if(blockers.length) return result('indeterminate',{reasons:[...new Set(blockers)],verifiedAudits:audits,
      accessSnapshotReferences:Object.values(accesses).filter(Boolean).map(item=>item.snapshot.evidenceReference),
      lifecycleEvidenceReference:lifecycle?.evidenceReference??null,markerProofReference:markerProof?.reference??null});

    const probeAudit=audits.probe;
    let classification='indeterminate';
    if(probeHasRead===false&&probeAudit.statusCode===200&&markerProof&&observationsData.probeRead.markerFingerprint===markerFingerprint)
      classification='unauthorized_success';
    else if(probeHasRead===false&&probeAudit.statusCode===403&&probeAudit.statusText==='AuthorizationPermissionMismatch')
      classification='confirmed_resource_denial';
    return result(classification,{reasons:classification==='indeterminate'?['probe_outcome_does_not_meet_independent_success_or_denial_rule']:[],
      verifiedAudits:audits,accessSnapshotReferences:Object.values(accesses).filter(Boolean).map(item=>item.snapshot.evidenceReference),
      lifecycleEvidenceReference:lifecycle.evidenceReference,markerProofReference:markerProof?.reference??null,
      independentlyComputedProbeHasBlobRead:probeHasRead,probeStatusCode:probeAudit.statusCode});
  }
  return verify;
}

