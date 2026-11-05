import {fingerprintProtectedEvidenceSnapshot} from './azure-versioned-protected-evidence.mjs';

const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN=/^[A-Za-z0-9_-]{1,150}$/;
const ARM='https://management.azure.com';

async function getJson(url,token,fetchImpl) {
  let response;
  try {response=await fetchImpl(url,{method:'GET',redirect:'error',headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});}
  catch {throw new Error('read-only ACI lifecycle ARM request failed');}
  if(!response.ok) throw new Error(`read-only ACI lifecycle ARM request returned HTTP ${response.status}`);
  try {return await response.json();} catch {throw new Error('read-only ACI lifecycle ARM response was invalid');}
}

async function getMaybeMissing(url,token,fetchImpl) {
  let response;
  try {response=await fetchImpl(url,{method:'GET',redirect:'error',headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});}
  catch {throw new Error('read-only ACI lifecycle ARM request failed');}
  if(response.status===404) {await response.body?.cancel();return {status:404};}
  if(!response.ok) {await response.body?.cancel();throw new Error(`read-only ACI lifecycle ARM request returned HTTP ${response.status}`);}
  try {return {status:response.status,body:await response.json()};} catch {throw new Error('read-only ACI lifecycle ARM response was invalid');}
}

export function createAciAzureLifecycleObserver({subscriptionId,resourceGroup,getManagementToken,fetchImpl=fetch,now=()=>Date.now(),
  apiVersion='2023-05-01',activityApiVersion='2015-04-01',observerPrincipalId,persistSnapshot,loadProtectedEvidence}={}) {
  if(!GUID.test(subscriptionId||'')||!resourceGroup||typeof getManagementToken!=='function'||typeof fetchImpl!=='function')
    throw new Error('ACI lifecycle observer requires subscription, resource group, and independent read-only ARM token');
  const root=`${ARM}/subscriptions/${subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}`;
  async function token() {const value=await getManagementToken();if(typeof value!=='string'||value.length<20||/\s/.test(value))throw new Error('independent audit ARM token unavailable');return value;}
  async function saveLifecycleObservation({runId,scenario,group,identity,state,createdAt,deletedAt,observedAt,attachedPrincipalObjectIds}) {
    if(typeof persistSnapshot!=='function'||!GUID.test(observerPrincipalId||'')) return undefined;
    const snapshot={schema:'azure_aci_arm_activity_snapshot_v1',runId,scenario,observerPrincipalId:observerPrincipalId.toLowerCase(),
      observedAt,groups:[{runId,scenario,name:group.name,resourceId:group.resourceId,provisioningState:state==='Running'?'Succeeded':state,
        workloadIdentityObjectId:identity.objectId.toLowerCase(),attachedPrincipalObjectIds:[...attachedPrincipalObjectIds].sort(),
        createdAt,...(deletedAt?{deletedAt}:{}),stateObservations:[{state,observedAt}]}],identities:[],
      completeness:{activityLogRead:false,groupAttachmentHistory:true,identityDeletionAndGrantRemoval:false}};
    const saved=await persistSnapshot({snapshot,observerPrincipalId:observerPrincipalId.toLowerCase()});
    if(typeof saved?.reference!=='string'||typeof saved?.versionId!=='string') throw new Error('protected lifecycle snapshot was not version-pinned');
    return {reference:saved.reference,snapshotFingerprint:fingerprintProtectedEvidenceSnapshot(snapshot),observedAt,snapshot};
  }
  async function observeGroup({group,identity,runId,scenario}) {
    if(!group||typeof group.name!=='string'||typeof group.resourceId!=='string'||!GUID.test(identity?.objectId||''))
      throw new Error('ACI group observation requires exact group ARM ID and expected workload principal');
    const url=`${ARM}${group.resourceId}?api-version=${apiVersion}`;
    const body=await getJson(url,await token(),fetchImpl);
    const identityMap=body?.identity?.userAssignedIdentities;
    if(!identityMap||typeof identityMap!=='object'||Array.isArray(identityMap))throw new Error('ACI ARM response omitted attached user-assigned identities');
    const attached=[];
    for(const id of Object.keys(identityMap)) {
      if(!id.startsWith('/subscriptions/'))throw new Error('ACI group contains a malformed attached identity resource ID');
      const uai=await getJson(`${ARM}${id}?api-version=2023-01-31`,await token(),fetchImpl);
      const principalId=uai?.properties?.principalId;
      if(!GUID.test(principalId||''))throw new Error('attached UAI principal ID could not be resolved by independent observer');
      attached.push(principalId.toLowerCase());
    }
    const workloadIdentityObjectId=attached.find(value=>value===identity.objectId.toLowerCase());
    if(!workloadIdentityObjectId||attached.length!==2)throw new Error('ACI group does not have exactly workload plus pull identity attached');
    const state=body?.properties?.instanceView?.state??body?.properties?.provisioningState;
    const normalizedState=state==='Running'?'Running':state==='Succeeded'?'Running':state;
    const createdAt=body?.systemData?.createdAt;
    if(typeof normalizedState!=='string'||!Number.isFinite(Date.parse(createdAt)))throw new Error('ACI ARM response omitted observed group state or creation time');
    const observedAt=new Date(now()).toISOString();
    const result={state:normalizedState,name:group.name,resourceId:body.id,identityObjectId:workloadIdentityObjectId,
      attachedPrincipalObjectIds:attached.sort(),createdAt,observedAt};
    result.lifecycleEvidence=await saveLifecycleObservation({runId,scenario,
      group:{name:result.name,resourceId:result.resourceId},identity, state:normalizedState,createdAt,observedAt,
      attachedPrincipalObjectIds:attached});
    return result;
  }
  async function observeGroupDeletion({group,identity,runId,scenario,timeoutMs=60000,pollIntervalMs=1000}) {
    if(!group||typeof group.name!=='string'||typeof group.resourceId!=='string'||!GUID.test(identity?.objectId||'')||
      !RUN.test(runId||'')||!['U6','U8'].includes(scenario)||!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>180000||
      !Number.isInteger(pollIntervalMs)||pollIntervalMs<100||pollIntervalMs>10000)
      throw new Error('ACI deletion observation request is invalid');
    const deadline=now()+timeoutMs;
    while(now()<deadline) {
      const accessToken=await token();
      let response;
      try {response=await fetchImpl(`${ARM}${group.resourceId}?api-version=${apiVersion}`,{method:'GET',redirect:'error',
        headers:{authorization:`Bearer ${accessToken}`},signal:AbortSignal.timeout(30000)});}
      catch {throw new Error('independent ACI deletion observation failed');}
      if(response.status===404) {
        await response.body?.cancel();
        const absentAt=new Date(now()).toISOString();
        const lifecycleEvidence=await saveLifecycleObservation({runId,scenario,group,identity,state:'Absent',createdAt:group.createdAt,
          deletedAt:absentAt,observedAt:absentAt,attachedPrincipalObjectIds:group.attachedPrincipalObjectIds||[identity.objectId]});
        return {state:'Absent',name:group.name,resourceId:group.resourceId,identityObjectId:identity.objectId.toLowerCase(),
          observedAt:absentAt,lifecycleEvidence};
      }
      if(!response.ok) {await response.body?.cancel();throw new Error(`independent ACI deletion observation returned HTTP ${response.status}`);}
      await response.body?.cancel();
      await new Promise(resolve=>setTimeout(resolve,Math.min(pollIntervalMs,Math.max(1,deadline-now()))));
    }
    throw new Error('independent ACI deletion observation timed out');
  }
  async function readAciLifecycleEvidence({runId,scenario,evidence,observerPrincipalId}) {
    if(!RUN.test(runId||'')||!['U6','U8'].includes(scenario)||!GUID.test(observerPrincipalId||''))
      throw new Error('ACI Activity Log review requires a valid U6/U8 run and independent observer');
    const times=[...(evidence?.events||[]).map(x=>x.at),evidence?.observations?.probeRead?.startedAt].map(Date.parse).filter(Number.isFinite);
    if(!times.length)throw new Error('ACI lifecycle evidence has no bounded activity interval');
    const start=new Date(Math.min(...times)-120000).toISOString(),end=new Date(Math.max(...times)+120000).toISOString();
    const filter=`eventTimestamp ge '${start}' and eventTimestamp le '${end}' and resourceGroupName eq '${resourceGroup}'`;
    let next=`${ARM}/subscriptions/${subscriptionId}/providers/microsoft.insights/eventtypes/management/values?api-version=${activityApiVersion}&$filter=${encodeURIComponent(filter)}`;
    const rows=[];let pageCount=0;const managementToken=await token();
    while(next) {
      if(++pageCount>50)throw new Error('ACI Activity Log pagination exceeded safety limit');
      const url=new URL(next);if(url.origin!==ARM)throw new Error('ACI Activity Log next link left the ARM host');
      const page=await getJson(url.href,managementToken,fetchImpl);
      if(!Array.isArray(page.value))throw new Error('ACI Activity Log page omitted its value array');
      rows.push(...page.value);
      next=page.nextLink||null;
    }
    const relevant=rows.filter(item=>typeof item?.resourceId==='string'&&
      (item.resourceId.toLowerCase().includes('/containergroups/')||item.resourceId.toLowerCase().includes('/userassignedidentities/')||
       item.resourceId.toLowerCase().includes('/roleassignments/'))).map(item=>({resourceId:item.resourceId,
      operationName:item.operationName?.value||null,status:item.status?.value||null,eventTimestamp:item.eventTimestamp||null,
      correlationId:item.correlationId||null,caller:item.caller||null}));
    // Activity Log corroborates actor/operation timing. Identity attachments
    // come from separate live ARM reads persisted under locked Blob versions;
    // Activity Log request bodies are not assumed to contain the identity map.
    const lifecycleReferences=[];
    const collect=value=>{
      if(!value||typeof value!=='object') return;
      if(value.lifecycleEvidence&&typeof value.lifecycleEvidence.reference==='string') lifecycleReferences.push(value.lifecycleEvidence);
      for(const [key,item] of Object.entries(value)) if(key!=='lifecycleEvidence') {
        if(Array.isArray(item)) item.forEach(collect); else if(item&&typeof item==='object') collect(item);
      }
    };
    collect(evidence);
    const groupsByName=new Map();let groupAttachmentHistory=typeof loadProtectedEvidence==='function'&&lifecycleReferences.length>0;
    for(const reference of lifecycleReferences) {
      let stored;
      try {stored=await loadProtectedEvidence({reference:reference.reference,observerPrincipalId:observerPrincipalId.toLowerCase()});}
      catch {groupAttachmentHistory=false;continue;}
      if(!stored||stored.reference!==reference.reference||stored.readerPrincipalId?.toLowerCase()!==observerPrincipalId.toLowerCase()||
        stored.immutable!==true||stored.retentionPolicyState!=='Locked'||!stored.snapshot||
        fingerprintProtectedEvidenceSnapshot(stored.snapshot)!==reference.snapshotFingerprint||
        stored.snapshotFingerprint!==reference.snapshotFingerprint) {groupAttachmentHistory=false;continue;}
      for(const observation of stored.snapshot.groups||[]) {
        if(observation.runId!==runId||observation.scenario!==scenario||!observation.name||!observation.resourceId) {groupAttachmentHistory=false;continue;}
        const group=groupsByName.get(observation.name)??{name:observation.name,resourceId:observation.resourceId,
          provisioningState:'Succeeded',workloadIdentityObjectId:observation.workloadIdentityObjectId,
          attachedPrincipalObjectIds:observation.attachedPrincipalObjectIds,createdAt:observation.createdAt,stateObservations:[]};
        if(group.resourceId!==observation.resourceId||group.workloadIdentityObjectId?.toLowerCase()!==observation.workloadIdentityObjectId?.toLowerCase()||
          JSON.stringify([...group.attachedPrincipalObjectIds].sort())!==JSON.stringify([...observation.attachedPrincipalObjectIds].sort()))
          groupAttachmentHistory=false;
        group.stateObservations.push(...(observation.stateObservations||[]));
        if(observation.deletedAt) group.deletedAt=observation.deletedAt;
        groupsByName.set(observation.name,group);
      }
    }
    const groups=[...groupsByName.values()];
    const armToken=await token();
    let identityDeletionAndGrantRemoval=Array.isArray(evidence?.events)&&typeof observerPrincipalId==='string';
    const evidenceEvents=Array.isArray(evidence?.events)?evidence.events:[];
    const created=evidenceEvents.filter(item=>item?.stage==='identity_created');
    const cleaned=new Map([...evidenceEvents,...(Array.isArray(evidence?.cleanupEvents)?evidence.cleanupEvents:[])].filter(item=>item?.stage==='identity_cleanup_confirmed')
      .map(item=>[item.objectId?.toLowerCase(),item]));
    const identities=[];
    for(const event of created) {
      const removal=cleaned.get(event.objectId?.toLowerCase());
      if(!removal||removal.resourceId!==event.resourceId||!Array.isArray(event.assignmentIds)||
        JSON.stringify([...event.assignmentIds].sort())!==JSON.stringify([...(removal.assignmentIds||[])].sort())) {
        identityDeletionAndGrantRemoval=false;continue;
      }
      let current;
      try {current=await getMaybeMissing(`${ARM}${event.resourceId}?api-version=2023-01-31`,armToken,fetchImpl);}
      catch {identityDeletionAndGrantRemoval=false;continue;}
      if(current.status!==404) {identityDeletionAndGrantRemoval=false;continue;}
      let rolesGone=true;
      for(const assignmentId of event.assignmentIds) {
        if(typeof assignmentId!=='string'||!assignmentId.startsWith('/subscriptions/')) {rolesGone=false;break;}
        try {
          const role=await getMaybeMissing(`${ARM}${assignmentId}?api-version=2022-04-01`,armToken,fetchImpl);
          if(role.status!==404) rolesGone=false;
        } catch {rolesGone=false;}
      }
      if(!rolesGone) {identityDeletionAndGrantRemoval=false;continue;}
      const createdEvent=relevant.find(item=>item.resourceId?.toLowerCase()===event.resourceId.toLowerCase()&&
        /\/write$/i.test(item.operationName||'')&&item.status==='Succeeded');
      const deletedEvent=relevant.some(item=>item.resourceId?.toLowerCase()===event.resourceId.toLowerCase()&&
        /\/delete$/i.test(item.operationName||'')&&item.status==='Succeeded');
      const roleDeletes=event.assignmentIds.every(id=>relevant.some(item=>item.resourceId?.toLowerCase()===id.toLowerCase()&&
        /\/delete$/i.test(item.operationName||'')&&item.status==='Succeeded'));
      if(!createdEvent||!deletedEvent||!roleDeletes) identityDeletionAndGrantRemoval=false;
      identities.push({objectId:event.objectId,resourceId:event.resourceId,role:event.role,createdAt:createdEvent?.eventTimestamp,
        deletedAt:new Date(now()).toISOString(),
        roleAssignmentsRemoved:rolesGone&&removal.roleAssignmentsRemoved===true});
    }
    if(created.length===0||identities.length!==created.length) identityDeletionAndGrantRemoval=false;
    for(const group of groups) {
      const eventsForGroup=relevant.filter(item=>item.resourceId?.toLowerCase()===group.resourceId.toLowerCase());
      const hasWrite=eventsForGroup.some(item=>/\/write$/i.test(item.operationName||'')&&item.status==='Succeeded');
      const hasDelete=eventsForGroup.some(item=>/\/delete$/i.test(item.operationName||'')&&item.status==='Succeeded');
      if(!hasWrite||!hasDelete||!Number.isFinite(Date.parse(group.createdAt))||!Number.isFinite(Date.parse(group.deletedAt))||
        !Array.isArray(group.attachedPrincipalObjectIds)||group.attachedPrincipalObjectIds.length!==2) groupAttachmentHistory=false;
    }
    if(groups.length===0) groupAttachmentHistory=false;
    const snapshot={schema:'azure_aci_arm_activity_snapshot_v1',runId,scenario,observerPrincipalId:observerPrincipalId.toLowerCase(),
      observedAt:new Date(now()).toISOString(),window:{from:start,to:end},activityLogEvents:relevant,groups,identities,
      completeness:{activityLogRead:true,groupAttachmentHistory,identityDeletionAndGrantRemoval}};
    const snapshotFingerprint=fingerprintProtectedEvidenceSnapshot(snapshot);
    if(typeof persistSnapshot!=='function') {
      snapshot.completeness.groupAttachmentHistory=false;
      snapshot.completeness.identityDeletionAndGrantRemoval=false;
      return {source:'azure_aci_arm_activity_snapshot_v1',readOnly:true,httpStatus:200,
        observerPrincipalId:observerPrincipalId.toLowerCase(),snapshot,snapshotFingerprint};
    }
    const persisted=await persistSnapshot({snapshot,observerPrincipalId:observerPrincipalId.toLowerCase()});
    return {source:'azure_aci_arm_activity_snapshot_v1',readOnly:true,httpStatus:200,observerPrincipalId:observerPrincipalId.toLowerCase(),
      snapshot,snapshotFingerprint,evidenceReference:persisted?.reference};
  }
  return Object.freeze({observeGroup,observeGroupDeletion,readAciLifecycleEvidence});
}

export function createFailClosedCredentialPathReviewer() {
  return async()=>({status:'incomplete',source:'azure_live_identity_credential_path_review_v1',allPathsResolved:false,
    unresolvedPaths:['azure_graph_group_membership_and_indirect_credential_path_proof_not_configured'],readOnly:true});
}
