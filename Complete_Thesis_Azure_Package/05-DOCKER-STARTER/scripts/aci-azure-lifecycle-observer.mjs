import {fingerprintProtectedEvidenceSnapshot} from './azure-versioned-protected-evidence.mjs';

const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ARM='https://management.azure.com';

async function getJson(url,token,fetchImpl) {
  let response;
  try {response=await fetchImpl(url,{method:'GET',redirect:'error',headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});}
  catch {throw new Error('read-only ACI lifecycle ARM request failed');}
  if(!response.ok) throw new Error(`read-only ACI lifecycle ARM request returned HTTP ${response.status}`);
  try {return await response.json();} catch {throw new Error('read-only ACI lifecycle ARM response was invalid');}
}

export function createAciAzureLifecycleObserver({subscriptionId,resourceGroup,getManagementToken,fetchImpl=fetch,now=()=>Date.now(),
  apiVersion='2023-05-01',activityApiVersion='2015-04-01'}={}) {
  if(!GUID.test(subscriptionId||'')||!resourceGroup||typeof getManagementToken!=='function'||typeof fetchImpl!=='function')
    throw new Error('ACI lifecycle observer requires subscription, resource group, and independent read-only ARM token');
  const root=`${ARM}/subscriptions/${subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}`;
  async function token() {const value=await getManagementToken();if(typeof value!=='string'||value.length<20||/\s/.test(value))throw new Error('independent audit ARM token unavailable');return value;}
  async function observeGroup({group,identity}) {
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
    if(typeof normalizedState!=='string')throw new Error('ACI ARM response omitted observed group state');
    return {state:normalizedState,name:group.name,resourceId:body.id,identityObjectId:workloadIdentityObjectId,
      attachedPrincipalObjectIds:attached.sort(),observedAt:new Date(now()).toISOString()};
  }
  async function readAciLifecycleEvidence({runId,scenario,evidence,observerPrincipalId}) {
    if(!/^pilot-[A-Za-z0-9_-]{1,140}$/.test(runId||'')||!['U6','U8'].includes(scenario)||!GUID.test(observerPrincipalId||''))
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
    // Activity Log is useful corroboration, but its standard event schema does
    // not expose the historical attached UAI principal set or complete UAI
    // role-assignment deletion inventory. Do not synthesize those assertions.
    const snapshot={schema:'azure_aci_arm_activity_snapshot_v1',runId,scenario,observerPrincipalId:observerPrincipalId.toLowerCase(),
      observedAt:new Date(now()).toISOString(),window:{from:start,to:end},activityLogEvents:relevant,groups:[],identities:[],
      completeness:{activityLogRead:true,groupAttachmentHistory:false,identityDeletionAndGrantRemoval:false}};
    return {source:'azure_aci_arm_activity_snapshot_v1',readOnly:true,httpStatus:200,observerPrincipalId:observerPrincipalId.toLowerCase(),
      snapshot,snapshotFingerprint:fingerprintProtectedEvidenceSnapshot(snapshot)};
  }
  return Object.freeze({observeGroup,readAciLifecycleEvidence});
}

export function createFailClosedCredentialPathReviewer() {
  return async()=>({status:'incomplete',source:'azure_live_identity_credential_path_review_v1',allPathsResolved:false,
    unresolvedPaths:['azure_graph_group_membership_and_indirect_credential_path_proof_not_configured'],readOnly:true});
}
