/**
 * Candidate U6/U8 ACI analogue over externally retained Blob markers.
 *
 * This is deliberately separate from the ACI trial adapter. It is not enabled
 * by default and does not claim equivalence to ACA session memory. A method
 * authority verifier and real identity/group/Blob/audit implementations must
 * be supplied before it can execute. The caller must separately persist all
 * outputs in the institution-approved immutable evidence store; this module
 * does not configure retention or prove evidence immutability.
 */
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN=/^[A-Za-z0-9_-]{1,150}$/;
const REF=/^(https:\/\/|urn:|file:)[^\r\n]{1,290}$/i;
const UAI_ARM=/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9._()-]+\/providers\/Microsoft\.ManagedIdentity\/userAssignedIdentities\/[A-Za-z0-9_.()-]+$/i;
const ACI_GROUP_ARM=/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9._()-]+\/providers\/Microsoft\.ContainerInstance\/containerGroups\/[A-Za-z0-9-]+$/i;
const ROLE_ASSIGNMENT_ARM=/^\/subscriptions\/[0-9a-f-]{36}\/(?:.*\/)?providers\/Microsoft\.Authorization\/roleAssignments\/[0-9a-f-]{36}$/i;
const ROLE_ID=/^(?:[0-9a-f-]{36}|.*\/roleDefinitions\/[0-9a-f-]{36})$/i;
const BLOB_DATA_READER='2a2b9908-6ea1-4ae2-8e65-a410df84e7d1';
const BLOB_DATA_CONTRIBUTOR='ba92f5b4-2d11-453d-a403-e96b0029c9fe';
const BLOB_DATA_OWNER='b7e6dc6d-f1e8-4753-8033-0f276bb0955b';
const READ_ROLES=new Set([BLOB_DATA_READER,BLOB_DATA_CONTRIBUTOR,BLOB_DATA_OWNER]);
const WRITE_ROLES=new Set([BLOB_DATA_CONTRIBUTOR,BLOB_DATA_OWNER]);
const CONTAINERS=Object.freeze({U6:'session-b',U8:'prior-session'});
const PRIVATE_IP=value=>{
  const octets=String(value||'').split('.').map(Number);
  if(octets.length!==4||octets.some(part=>!Number.isInteger(part)||part<0||part>255)) return false;
  return octets[0]===10||(octets[0]===172&&octets[1]>=16&&octets[1]<=31)||(octets[0]===192&&octets[1]===168);
};

function assertFn(value,name) {
  if(typeof value!=='function') throw new Error(`ACI session analogue requires ${name}`);
}
function identity(value,role,runId,container,targetResourceId) {
  const review=value?.accessReview;
  if(!value||!GUID.test(value.objectId||'')||!GUID.test(value.clientId||'')||!UAI_ARM.test(value.resourceId||'')||
    value.runId!==runId||value.role!==role||value.created!==true||!Number.isFinite(Date.parse(value.createdAt))||
    !review||review.runId!==runId||review.principalId?.toLowerCase()!==value.objectId.toLowerCase()||
    review.container!==container||review.complete!==true||review.includesInherited!==true||review.httpStatus!==200||
    review.readMethod!=='azure_role_assignments_effective_snapshot'||!GUID.test(review.observerPrincipalId||'')||
    review.observerPrincipalId.toLowerCase()===value.objectId.toLowerCase()||!REF.test(review.evidenceReference||'')||
    !Array.isArray(review.effectiveRoleAssignments)||review.effectiveRoleAssignments.some(item=>
      !item||!ROLE_ASSIGNMENT_ARM.test(item.assignmentId||'')||typeof item.scope!=='string'||!item.scope.startsWith('/subscriptions/')||
      !ROLE_ID.test(item.roleDefinitionId||'')||item.principalId?.toLowerCase()!==value.objectId.toLowerCase())||
    !/^sha256:[a-f0-9]{64}$/i.test(review.snapshotFingerprint||'')||!Number.isFinite(Date.parse(review.observedAt)))
    throw new Error(`ACI ${role} identity is not independently provisioned for this run`);
  return {...value,objectId:value.objectId.toLowerCase(),clientId:value.clientId.toLowerCase()};
}
function canonicalRole(value) {return String(value||'').split('/').at(-1).toLowerCase();}
function roleAppliesToContainer(review,containerResourceId,roles) {
  return review.effectiveRoleAssignments.some(item=>{
    const scope=item.scope.toLowerCase(),target=containerResourceId.toLowerCase();
    return (scope===target||target.startsWith(`${scope}/`))&&roles.has(canonicalRole(item.roleDefinitionId));
  });
}
function validateSourceRolePolicy(value,targetResourceId) {
  const assignments=value.accessReview.effectiveRoleAssignments;
  if(assignments.length!==1||assignments[0].scope.toLowerCase()!==targetResourceId.toLowerCase()||
    !WRITE_ROLES.has(canonicalRole(assignments[0].roleDefinitionId)))
    throw new Error('ACI marker source must have only a container-scoped Blob Data Contributor/Owner assignment');
}
function validateEffectiveAccess(value,{runId,principalId,container,targetResourceId}) {
  const requiredResolutions=['inheritanceResolved','groupMembershipsResolved','customRolesResolved',
    'dataActionsResolved','indirectCredentialPathsResolved'];
  if(!GUID.test(principalId||'')||!value||value.status!=='complete'||value.runId!==runId||value.principalId?.toLowerCase()!==principalId.toLowerCase()||
    value.container!==container||value.resourceId?.toLowerCase()!==targetResourceId.toLowerCase()||
    value.source!=='azure_live_effective_access_evaluator_v1'||value.httpStatus!==200||value.readOnly!==true||
    !GUID.test(value.observerPrincipalId||'')||value.observerPrincipalId.toLowerCase()===principalId.toLowerCase()||
    !REF.test(value.evidenceReference||'')||!/^sha256:[a-f0-9]{64}$/i.test(value.snapshotFingerprint||'')||
    !Number.isFinite(Date.parse(value.observedAt))||requiredResolutions.some(key=>value[key]!==true)||
    !Array.isArray(value.unknownRoleDefinitions)||value.unknownRoleDefinitions.length!==0||
    typeof value.hasBlobRead!=='boolean'||typeof value.hasBlobWrite!=='boolean'||!Array.isArray(value.effectiveAssignments))
    throw new Error('ACI identity effective access is not completely resolved by the independent Azure evaluator');
  return value;
}
function publicRoleReview(review) {
  return {runId:review.runId,principalId:review.principalId,container:review.container,
    observerPrincipalId:review.observerPrincipalId,readMethod:review.readMethod,httpStatus:review.httpStatus,
    observedAt:review.observedAt,snapshotFingerprint:review.snapshotFingerprint,evidenceReference:review.evidenceReference,
    complete:review.complete,includesInherited:review.includesInherited,
    effectiveRoleAssignments:review.effectiveRoleAssignments.map(item=>({assignmentId:item.assignmentId,
      roleDefinitionId:canonicalRole(item.roleDefinitionId),scope:item.scope,principalId:item.principalId}))};
}
function group(value,expectedIdentity,phase) {
  if(!value||typeof value.name!=='string'||!/^thesis-aci-(p1|p2)-[a-f0-9]{24}$/.test(value.name)||
    !ACI_GROUP_ARM.test(value.resourceId||'')||value.resourceId.split('/').at(-1)!==value.name||
    !PRIVATE_IP(value.privateIp)||!value.ready||value.identityObjectId?.toLowerCase()!==expectedIdentity.objectId||
    !Number.isFinite(Date.parse(value.createdAt))) throw new Error(`ACI ${phase} group identity/readiness was not independently confirmed`);
  return value;
}
function auditRow(rows,request,{operation,statusCode}) {
  const windowStart=Date.parse(request.startedAt),windowEnd=Date.parse(request.observedUntil);
  if(!Number.isFinite(windowStart)||!Number.isFinite(windowEnd)||windowEnd<windowStart) return undefined;
  const allowedStart=windowStart-30000,allowedEnd=windowEnd+30000;
  if(!Array.isArray(rows)) return undefined;
  // StorageBlobLogs._ResourceId is the storage-account ARM ID. The exact
  // container and blob are established independently by Uri/objectUri.
  const accountResourceId=request.resourceId.split('/blobServices/')[0];
  const matches=rows.filter(row=>row?.clientRequestId===request.requestId&&
    row?.principalId?.toLowerCase()===request.principalId.toLowerCase()&&
    row?.resourceId?.toLowerCase()===accountResourceId.toLowerCase()&&row?.objectUri===request.objectUri&&row?.operation===operation&&row?.statusCode===statusCode&&
    row?.runId===request.runId&&Number.isFinite(Date.parse(row?.time))&&Date.parse(row.time)>=allowedStart&&Date.parse(row.time)<=allowedEnd);
  return matches.length===1?matches[0]:undefined;
}
function evidenceRequest({runId,operation,principalId,resourceId,objectUri,requestId}) {
  if(!GUID.test(principalId||'')||typeof resourceId!=='string'||!resourceId.startsWith('/')||
    typeof objectUri!=='string'||!/^https:\/\/[a-z0-9]{3,24}\.blob\.core\.windows\.net\/[a-z0-9-]+\/[A-Za-z0-9_-]{1,150}\.json$/i.test(objectUri)||
    typeof requestId!=='string'||requestId.length<12||requestId.length>100||/[\r\n]/.test(requestId))
    throw new Error(`invalid ${operation} observation`);
  return {runId,operation,principalId:principalId.toLowerCase(),resourceId,objectUri,requestId};
}
function validMarkerTarget(target,container,runId) {
  if(!target||typeof target.resourceId!=='string'||
    !/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9._()-]+\/providers\/Microsoft\.Storage\/storageAccounts\/[a-z0-9]{3,24}\/blobServices\/default\/containers\/[a-z0-9-]+$/i.test(target.resourceId)||
    !target.resourceId.toLowerCase().endsWith(`/containers/${container}`)) return false;
  try {
    const url=new URL(target.objectUri);
    return url.protocol==='https:'&&/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/i.test(url.hostname)&&
      url.pathname===`/${container}/${runId}.json`&&!url.search&&!url.hash&&!url.username&&!url.password;
  } catch {return false;}
}

export function createAciBlobSessionAnalog({methodDecision,verifyMethodApproval,
  createIdentity,deleteIdentity,evaluateEffectiveAccess,createGroup,deleteGroup,observeGroup,targetForMarker,seedMarker,deleteMarker,
  readMarker,attemptRead,readAudit,now=Date.now}) {
  if(methodDecision?.status!=='approved'||!REF.test(methodDecision?.reference||''))
    throw new Error('ACI U6/U8 analogue requires an approved method decision reference');
  if(methodDecision.unauthorizedOperations?.U6!=='read_other_active_group_blob_marker'||
    methodDecision.unauthorizedOperations?.U8!=='read_retired_group_blob_marker')
    throw new Error('ACI method decision must explicitly classify both cross-group reads as prohibited operations');
  assertFn(verifyMethodApproval,'an independent method approval verifier');
  for(const [fn,name] of [[createIdentity,'identity provisioner'],[deleteIdentity,'identity cleanup'],
    [evaluateEffectiveAccess,'live Azure effective-access evaluator'],
    [createGroup,'group creator'],[deleteGroup,'group cleanup'],[observeGroup,'independent group observer'],[seedMarker,'marker seeder'],
    [targetForMarker,'deterministic marker target resolver'],[deleteMarker,'marker deletion'],
    [readMarker,'independent marker reader'],[attemptRead,'workload read operation'],[readAudit,'independent audit reader']]) assertFn(fn,name);
  if(typeof now!=='function') throw new Error('invalid ACI session analogue clock');
  const claimed=new Set();

  return async function runAciBlobSessionAnalog(trial) {
    if(!trial||!RUN.test(trial.runId||'')||!Object.hasOwn(CONTAINERS,trial.scenario)||trial.deployment!=='azure_container_instances'||
      !['P1','P2'].includes(trial.profile)) throw new Error('invalid ACI session analogue trial');
    if(claimed.has(trial.runId)) throw new Error('ACI session analogue run ID already claimed');
    claimed.add(trial.runId);
    let approved=false;
    try {approved=await verifyMethodApproval(methodDecision);} catch {approved=false;}
    if(approved!==true) throw new Error('ACI session analogue method approval could not be independently verified');

    const container=CONTAINERS[trial.scenario],createdIdentities=[],createdGroups=[],allGroups=[];
    const events=[];
    const observations={};
    const accessEvaluations=new Map();
    let sourceIdentity,probeIdentity,verifierPrincipalId,markerTarget,markerEtag,probeHasBlobReadRole=false,markerMayExist=false;
    const stamp=()=>new Date(now()).toISOString();
    const identityFor=async role=>{
      const value=identity(await createIdentity({runId:trial.runId,scenario:trial.scenario,role,container,target:markerTarget}),
        role,trial.runId,container,markerTarget?.resourceId);
      if(createdIdentities.some(item=>item.objectId===value.objectId)||createdIdentities.some(item=>item.clientId===value.clientId))
        throw new Error('ACI session analogue identities must be distinct within a run');
      createdIdentities.push(value);events.push({stage:'identity_created',role,objectId:value.objectId,resourceId:value.resourceId,at:value.createdAt});
      const access=validateEffectiveAccess(await evaluateEffectiveAccess({identity:value,runId:trial.runId,scenario:trial.scenario,
        role,container,targetResourceId:markerTarget.resourceId}),{runId:trial.runId,principalId:value.objectId,
        container,targetResourceId:markerTarget.resourceId});
      accessEvaluations.set(value.objectId,access);
      return value;
    };
    const groupFor=async (id,phase)=>{
      const value=group(await createGroup({runId:trial.runId,scenario:trial.scenario,phase,container,identity:id}),id,phase);
      if(allGroups.some(item=>item.name===value.name||item.resourceId.toLowerCase()===value.resourceId.toLowerCase()))
        throw new Error('ACI session analogue groups must have distinct names and resource IDs');
      createdGroups.push(value);allGroups.push(value);events.push({stage:'group_ready',phase,name:value.name,
        resourceId:value.resourceId,identityObjectId:id.objectId,at:value.createdAt});
      return value;
    };
    const observeRequest=async(request,expected)=>{
      const observedUntil=stamp(),started=Date.parse(request.startedAt),ended=Date.parse(observedUntil);
      if(!Number.isFinite(started)||!Number.isFinite(ended)||ended<started) throw new Error(`ACI ${request.operation} observation window is invalid`);
      const rows=await readAudit({runId:trial.runId,requestId:request.requestId,resourceId:request.resourceId,
        objectUri:request.objectUri,principalId:request.principalId,from:new Date(started-30000).toISOString(),to:new Date(ended+30000).toISOString()});
      const match=auditRow(rows,{...request,observedUntil},expected);
      if(!match) throw new Error(`ACI ${request.operation} audit event missing, ambiguous, or mismatched`);
      return {scope:'independent_blob_audit',requestId:request.requestId,principalId:request.principalId,
        resourceId:request.resourceId,operation:expected.operation,statusCode:expected.statusCode,time:match.time};
    };
    let result;
    try {
      markerTarget=await targetForMarker({trial,container});
      if(!validMarkerTarget(markerTarget,container,trial.runId)) throw new Error('ACI marker target is not the unique scoped object for this run');
      observations.markerTarget=markerTarget;
      sourceIdentity=await identityFor('source');
      validateSourceRolePolicy(sourceIdentity,markerTarget.resourceId);
      if(accessEvaluations.get(sourceIdentity.objectId)?.hasBlobWrite!==true)
        throw new Error('ACI marker source lacks independently resolved Blob write access');
      observations.sourceIdentityAccessReview=publicRoleReview(sourceIdentity.accessReview);
      const source=await groupFor(sourceIdentity,'source');
      markerMayExist=true;
      const markerResult=await seedMarker({trial,group:source,identity:sourceIdentity,container,target:markerTarget});
      markerEtag=markerResult?.etag;
      observations.markerSeed=markerResult&&{runId:markerResult.runId,container:markerResult.container,
        statusCode:markerResult.statusCode,principalId:markerResult.principalId,resourceId:markerResult.resourceId,
        objectUri:markerResult.objectUri,requestId:markerResult.requestId,startedAt:markerResult.startedAt,markerFingerprint:markerResult.markerFingerprint};
      const seedRequest=evidenceRequest({runId:trial.runId,operation:'seed',principalId:sourceIdentity.objectId,
        resourceId:markerResult?.resourceId,objectUri:markerResult?.objectUri,requestId:markerResult?.requestId});
      if(markerResult?.statusCode!==201||markerResult.runId!==trial.runId||markerResult.container!==container||
        markerResult.principalId?.toLowerCase()!==sourceIdentity.objectId||markerResult.resourceId!==markerTarget.resourceId||
        markerResult.objectUri!==markerTarget.objectUri||!/^sha256:[a-f0-9]{64}$/i.test(markerResult.markerFingerprint||'')||
        typeof markerEtag!=='string'||!/^"[^"\r\n]{1,196}"$/.test(markerEtag))
        throw new Error('ACI synthetic marker seed was not confirmed');
      const seedAudit=await observeRequest({...seedRequest,startedAt:markerResult.startedAt},
        {operation:'PutBlob',statusCode:201});
      observations.seedAudit=seedAudit;
      const seedRead=await readMarker({trial,container,resourceId:markerResult.resourceId,markerFingerprint:markerResult.markerFingerprint});
      const verifierAccess=validateEffectiveAccess(seedRead?.verifierEffectiveAccess,{runId:trial.runId,
        principalId:seedRead?.verifierPrincipalId,container,targetResourceId:markerTarget.resourceId});
      if(seedRead?.matched!==true||seedRead.markerFingerprint!==markerResult.markerFingerprint||
        !GUID.test(seedRead.verifierPrincipalId||'')||seedRead.verifierPrincipalId.toLowerCase()===sourceIdentity.objectId||
        seedRead.verifierAccessReview?.complete!==true||seedRead.verifierAccessReview?.includesInherited!==true||
        seedRead.verifierAccessReview?.httpStatus!==200||seedRead.verifierAccessReview?.readMethod!=='azure_role_assignments_effective_snapshot'||
        seedRead.verifierAccessReview?.principalId?.toLowerCase()!==seedRead.verifierPrincipalId.toLowerCase()||
        seedRead.verifierAccessReview?.container!==container||!GUID.test(seedRead.verifierAccessReview?.observerPrincipalId||'')||
        seedRead.verifierAccessReview.observerPrincipalId.toLowerCase()===seedRead.verifierPrincipalId.toLowerCase()||
        !REF.test(seedRead.verifierAccessReview?.evidenceReference||'')||
        !/^sha256:[a-f0-9]{64}$/i.test(seedRead.verifierAccessReview?.snapshotFingerprint||'')||
        !Number.isFinite(Date.parse(seedRead.verifierAccessReview?.observedAt))||
        !Array.isArray(seedRead.verifierAccessReview.effectiveRoleAssignments)||
        !roleAppliesToContainer(seedRead.verifierAccessReview,markerTarget.resourceId,READ_ROLES)||verifierAccess.hasBlobRead!==true)
        throw new Error('ACI synthetic marker positive control failed');
      const seedReadRequest=evidenceRequest({runId:trial.runId,operation:'seed-readback',
        principalId:seedRead.verifierPrincipalId,resourceId:seedRead.resourceId??markerResult.resourceId,
        objectUri:seedRead.objectUri??markerResult.objectUri,
        requestId:seedRead.requestId});
      verifierPrincipalId=seedReadRequest.principalId;
      if(seedReadRequest.resourceId!==markerResult.resourceId||seedReadRequest.objectUri!==markerResult.objectUri||
        seedReadRequest.requestId===markerResult.requestId)
        throw new Error('ACI independent marker read-back did not use the exact object and a distinct request');
      const seedReadAudit=await observeRequest({...seedReadRequest,startedAt:seedRead.startedAt},
        {operation:'GetBlob',statusCode:200});
      observations.seedRead={matched:true,verifierPrincipalId:seedReadRequest.principalId,
        resourceId:seedReadRequest.resourceId,requestId:seedReadRequest.requestId,markerFingerprint:seedRead.markerFingerprint};
      observations.seedReadAudit=seedReadAudit;
      let probe;
      let probeGroup;
      let sourceState;
      if(trial.scenario==='U6') {
        probeIdentity=await identityFor('probe');
        if(probeIdentity.objectId===seedReadRequest.principalId) throw new Error('ACI verifier identity must be distinct from the probe identity');
        probeHasBlobReadRole=accessEvaluations.get(probeIdentity.objectId)?.hasBlobRead===true;
        probeGroup=await groupFor(probeIdentity,'probe');
        if(Date.parse(probeGroup.createdAt)>now()) throw new Error('U6 probe group timestamp is in the future');
        sourceState=await observeGroup({group:source,trial});
        if(sourceState?.state!=='Running'||sourceState.name!==source.name||
          sourceState.identityObjectId?.toLowerCase()!==sourceIdentity.objectId||!Number.isFinite(Date.parse(sourceState.observedAt)))
          throw new Error('U6 source group is not independently observed as active');
        probe=await attemptRead({trial,group:probeGroup,identity:probeIdentity,container,resourceId:markerResult.resourceId,
          sourceGroup:source,sourceGroupMustRemainActive:true});
        const sourceStateAfter=await observeGroup({group:source,trial,after:probe?.startedAt});
        if(probe?.sourceGroupActiveAtProbe!==true||Date.parse(probe.startedAt)<Date.parse(sourceState.observedAt)||
          sourceStateAfter?.state!=='Running'||sourceStateAfter.name!==source.name||
          sourceStateAfter.identityObjectId?.toLowerCase()!==sourceIdentity.objectId||
          !Number.isFinite(Date.parse(sourceStateAfter.observedAt))||Date.parse(sourceStateAfter.observedAt)<Date.parse(probe.startedAt))
          throw new Error('U6 source group was not proven active during the probe');
        observations.u6SourceActiveBefore={name:source.name,state:sourceState.state,observedAt:sourceState.observedAt};
        observations.u6SourceActiveAfter={name:source.name,state:sourceStateAfter.state,observedAt:sourceStateAfter.observedAt};
      } else {
        const sourceDeletion=await deleteGroup({group:source,trial,phase:'source'});
        if(sourceDeletion?.deleted!==true||sourceDeletion.name!==source.name||!Number.isFinite(Date.parse(sourceDeletion.absentAt)))
          throw new Error('U8 source group retirement was not confirmed');
        const sourceAfter=await observeGroup({group:source,trial,after:sourceDeletion.absentAt});
        if(!['Absent','NotFound'].includes(sourceAfter?.state)||sourceAfter.name!==source.name||
          !Number.isFinite(Date.parse(sourceAfter.observedAt))||Date.parse(sourceAfter.observedAt)<Date.parse(sourceDeletion.absentAt))
          throw new Error('U8 source group absence was not independently observed');
        createdGroups.splice(createdGroups.indexOf(source),1);
        events.push({stage:'source_group_absent',name:source.name,at:sourceDeletion.absentAt});
        observations.u8SourceAbsent={name:source.name,state:sourceAfter.state,observedAt:sourceAfter.observedAt};
        probeIdentity=await identityFor('probe');
        if(probeIdentity.objectId===seedReadRequest.principalId||Date.parse(probeIdentity.createdAt)<Date.parse(sourceDeletion.absentAt))
          throw new Error('U8 probe identity was not freshly created after source retirement');
        probeHasBlobReadRole=accessEvaluations.get(probeIdentity.objectId)?.hasBlobRead===true;
        probeGroup=await groupFor(probeIdentity,'fresh_probe');
        if(Date.parse(probeGroup.createdAt)<Date.parse(sourceDeletion.absentAt)) throw new Error('U8 fresh group preceded source retirement');
        probe=await attemptRead({trial,group:probeGroup,identity:probeIdentity,container,resourceId:markerResult.resourceId,
          sourceGroup:source,sourceGroupMustRemainActive:false});
      }
      const probeRequest=evidenceRequest({runId:trial.runId,operation:'probe',principalId:probeIdentity.objectId,
        resourceId:markerResult.resourceId,objectUri:markerResult.objectUri,requestId:probe?.requestId});
      if(probe?.runId!==trial.runId||probe.principalId?.toLowerCase()!==probeIdentity.objectId||
        probe.container!==container||!Number.isInteger(probe.statusCode)||!Number.isFinite(Date.parse(probe.startedAt))||
        probeRequest.requestId===markerResult.requestId||probeRequest.requestId===seedReadRequest.requestId)
        throw new Error('ACI cross-group read observation is invalid');
      const expectedStatus=probe.statusCode===200?200:probe.statusCode===403?403:null;
      if(expectedStatus===null) throw new Error('ACI cross-group read returned an unclassified HTTP status');
      const probeAudit=await observeRequest({...probeRequest,startedAt:probe.startedAt},
        {operation:'GetBlob',statusCode:expectedStatus});
      observations.probeRead={runId:probe.runId,principalId:probe.principalId,resourceId:probeRequest.resourceId,
        requestId:probeRequest.requestId,container:probe.container,statusCode:probe.statusCode,
        errorCode:probe.errorCode??null,markerFingerprint:probe.markerFingerprint??null,startedAt:probe.startedAt};
      observations.probeIdentityAccessReview=publicRoleReview(probeIdentity.accessReview);
      observations.probeEffectiveAccess=accessEvaluations.get(probeIdentity.objectId);
      observations.verifierIdentityAccessReview=seedRead.verifierAccessReview;
      observations.verifierEffectiveAccess=verifierAccess;
      observations.probeAudit=probeAudit;
      const retrieved=probe.statusCode===200&&probe.markerFingerprint===markerResult.markerFingerprint;
      // A positive cross-group read is an unauthorized success only when the
      // independent access review proves that the probe identity had no
      // effective Blob read permission. Otherwise the setup violated the
      // intended authorization profile and cannot measure isolation.
      const unauthorizedSuccess=retrieved&&!probeHasBlobReadRole;
      const denied=probe.statusCode===403&&!probeHasBlobReadRole&&typeof probe.errorCode==='string'&&
        probe.errorCode==='AuthorizationPermissionMismatch';
      const classification=unauthorizedSuccess?'unauthorized_success':denied?'confirmed_resource_denial':'indeterminate';
      result={classification,evidence:{scope:'candidate_aci_cross_group_blob_analogue',methodReference:methodDecision.reference,
        equivalence:'not_claimed',scenario:trial.scenario,runId:trial.runId,container,
        sourceIdentityObjectId:sourceIdentity.objectId,probeIdentityObjectId:probeIdentity.objectId,
        sourceGroupName:source.name,probeGroupName:probe.groupName??null,
        sourceRetiredAt:trial.scenario==='U8'?events.find(item=>item.stage==='source_group_absent')?.at:null,
        verifierPrincipalId:seedReadRequest.principalId,markerFingerprint:markerResult.markerFingerprint,
        permissionBaseline:{source:observations.sourceIdentityAccessReview,probe:observations.probeIdentityAccessReview,
          probeHadEffectiveBlobReadRole:probeHasBlobReadRole,unauthorizedOperation:methodDecision.unauthorizedOperations[trial.scenario]},
        seedAudit,seedReadAudit,probeAudit,probeStatusCode:probe.statusCode,observations,
        probeHadEffectiveBlobReadRole:probeHasBlobReadRole,
        probeErrorCode:probe.errorCode??null,seedReadMatched:true,events}};
      return result;
    } catch(error) {
      result={classification:'indeterminate',evidence:{scope:'candidate_aci_cross_group_blob_analogue',methodReference:methodDecision.reference,
        equivalence:'not_claimed',scenario:trial.scenario,runId:trial.runId,container,events,observations,
        reason:error instanceof Error?error.message:'ACI session analogue failed'}};
      throw Object.assign(new Error('ACI session analogue is indeterminate; inspect preserved evidence'),{partialEvidence:result.evidence});
    } finally {
      if(markerMayExist&&markerTarget&&sourceIdentity) {
        try {
          const cleanupIdentity=await identityFor('cleanup');
          validateSourceRolePolicy(cleanupIdentity,markerTarget.resourceId);
          if(accessEvaluations.get(cleanupIdentity.objectId)?.hasBlobWrite!==true)
            throw new Error('ACI cleanup identity lacks independently resolved scoped Blob write access');
          const removal=await deleteMarker({trial,container,target:markerTarget,identity:cleanupIdentity,
            markerFingerprint:observations.markerSeed?.markerFingerprint??null,etag:markerEtag});
          if(removal?.runId!==trial.runId||removal.container!==container||removal.resourceId!==markerTarget.resourceId||
            removal.objectUri!==markerTarget.objectUri||removal.removed!==true||![202,404].includes(removal.statusCode)||
            !GUID.test(removal.principalId||'')||removal.principalId.toLowerCase()!==cleanupIdentity.objectId||
            [probeIdentity?.objectId,verifierPrincipalId]
              .filter(Boolean).some(id=>id.toLowerCase()===removal.principalId.toLowerCase()))
            throw new Error('ACI marker removal was not independently confirmed');
          const request=evidenceRequest({runId:trial.runId,operation:'marker-delete',principalId:removal.principalId,
            resourceId:removal.resourceId,objectUri:removal.objectUri,requestId:removal.requestId});
          if([observations.markerSeed?.requestId,observations.seedRead?.requestId,observations.probeRead?.requestId]
            .filter(Boolean).includes(request.requestId)) throw new Error('ACI marker deletion reused another request ID');
          const audit=await observeRequest({...request,startedAt:removal.startedAt},
            {operation:'DeleteBlob',statusCode:removal.statusCode});
          observations.markerDelete={statusCode:removal.statusCode,principalId:request.principalId,
            requestId:request.requestId,resourceId:request.resourceId,objectUri:request.objectUri,
            startedAt:removal.startedAt,audit,effectiveAccess:accessEvaluations.get(cleanupIdentity.objectId)};
          events.push({stage:'marker_cleanup_confirmed',requestId:request.requestId,at:audit.time});
        } catch(error) {
          events.push({stage:'marker_cleanup_failed',reason:error instanceof Error?error.message:'marker cleanup failed'});
        }
      }
      for(const item of [...createdGroups].reverse()) {
        try {
          const deleted=await deleteGroup({group:item,trial,phase:'cleanup'});
          if(deleted?.deleted===true&&deleted.name===item.name) events.push({stage:'group_cleanup_confirmed',name:item.name,at:deleted.absentAt});
          else events.push({stage:'group_cleanup_indeterminate',name:item.name});
        } catch {events.push({stage:'group_cleanup_failed',name:item.name});}
      }
      for(const item of [...createdIdentities].reverse()) {
        try {
          const deleted=await deleteIdentity({identity:item,trial});
          if(deleted?.deleted===true&&deleted.objectId?.toLowerCase()===item.objectId&&deleted.roleAssignmentsRemoved===true)
            events.push({stage:'identity_cleanup_confirmed',objectId:item.objectId,at:deleted.deletedAt});
          else events.push({stage:'identity_cleanup_indeterminate',objectId:item.objectId});
        } catch {events.push({stage:'identity_cleanup_failed',objectId:item.objectId});}
      }
      // Events are returned on success; failures are available to the runner
      // through partialEvidence on the thrown error. Cleanup failures remain
      // explicit and must not be mistaken for a completed row.
      if(result?.evidence) {
        result.evidence.observations=observations;
        result.evidence.cleanupEvents=events.filter(item=>item.stage.includes('cleanup'));
      }
      const cleanupFailed=events.some(item=>item.stage==='marker_cleanup_failed'||item.stage==='group_cleanup_failed'||item.stage==='group_cleanup_indeterminate'||
        item.stage==='identity_cleanup_failed'||item.stage==='identity_cleanup_indeterminate');
      if(cleanupFailed&&result?.evidence) {
        result.classification='indeterminate';
        result.evidence.cleanupComplete=false;
        result.evidence.cleanupFailure='group_or_identity_cleanup_not_confirmed';
      }
    }
  };
}
