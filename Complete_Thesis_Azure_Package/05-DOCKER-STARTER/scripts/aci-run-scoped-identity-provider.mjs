import {createHash} from 'node:crypto';

const API_IDENTITY='2023-01-31';
const API_RBAC='2022-04-01';
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_NAME=/^[a-z0-9-]{3,90}$/;
const BLOB_CONTRIBUTOR='ba92f5b4-2d11-453d-a403-e96b0029c9fe';
const BLOB_OWNER='b7e6dc6d-f1e8-4753-8033-0f276bb0955b';
const BLOB_READER='2a2b9908-6ea1-4ae2-8e65-a410df84e7d1';
const ROLES=new Set(['source','probe','cleanup']);
const CONTAINERS=new Set(['session-b','prior-session']);
const RUN=/^[A-Za-z0-9_-]{1,150}$/;
const ARM_SCOPE=/^\/subscriptions\/([0-9a-f-]{36})\/resourceGroups\/([A-Za-z0-9._()-]+)\/providers\/Microsoft\.Storage\/storageAccounts\/([a-z0-9]{3,24})\/blobServices\/default\/containers\/([a-z0-9-]+)$/i;

function guidFromSeed(seed) {
  const bytes=createHash('sha256').update(seed).digest().subarray(0,16);
  bytes[6]=(bytes[6]&0x0f)|0x50;
  bytes[8]=(bytes[8]&0x3f)|0x80;
  const hex=bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function expectedName(runId,scenario,role) {
  const digest=createHash('sha256').update(`${runId}|${scenario}|${role}`).digest('hex').slice(0,32);
  return `aci-${digest}-${role}`;
}

function validateSnapshot(value,{runId,principalId,role,targetResourceId,assignmentId}) {
  if(!value||value.runId!==runId||value.principalId?.toLowerCase()!==principalId.toLowerCase()||
    value.status!=='complete'||value.complete!==true||value.includesInherited!==true||
    value.groupMembershipsResolved!==true||!Array.isArray(value.groupPrincipalIds)||value.groupPrincipalIds.length!==0||
    value.customRolesResolved!==true||value.dataActionsResolved!==true||value.indirectCredentialPathsResolved!==true||
    value.unknownRoleDefinitions?.length!==0||value.httpStatus!==200||value.readOnly!==true||
    value.readMethod!=='azure_role_assignments_effective_snapshot'||!GUID.test(value.observerPrincipalId||'')||
    value.observerPrincipalId.toLowerCase()===principalId.toLowerCase()||
    typeof value.evidenceReference!=='string'||!/^https:\/\/[^\s]{1,290}$/i.test(value.evidenceReference)||
    !/^sha256:[a-f0-9]{64}$/i.test(value.snapshotFingerprint||'')||!Number.isFinite(Date.parse(value.observedAt))||
    !Array.isArray(value.effectiveRoleAssignments))
    throw new Error('independent Azure effective-role snapshot is incomplete or invalid');
  for(const assignment of value.effectiveRoleAssignments) {
    if(!assignment||typeof assignment.assignmentId!=='string'||
      !/^\/subscriptions\/[0-9a-f-]{36}\/.*\/providers\/Microsoft\.Authorization\/roleAssignments\/[0-9a-f-]{36}$/i.test(assignment.assignmentId)||
      typeof assignment.scope!=='string'||!assignment.scope.startsWith('/subscriptions/')||
      typeof assignment.roleDefinitionId!=='string'||assignment.principalId?.toLowerCase()!==principalId.toLowerCase())
      throw new Error('independent Azure effective-role snapshot contains an unrecognized assignment');
  }
  if(['source','cleanup'].includes(role)) {
    if(value.effectiveRoleAssignments.length!==1)
      throw new Error('source/cleanup identity effective role is not the single container-scoped Blob Data Contributor assignment');
    const only=value.effectiveRoleAssignments[0];
    if(only.assignmentId.toLowerCase()!==assignmentId.toLowerCase()) throw new Error('source/cleanup role snapshot omitted the created role assignment');
    if(only.scope.toLowerCase()!==targetResourceId.toLowerCase()) throw new Error('source/cleanup role snapshot is not at the exact target container scope');
    if(only.roleDefinitionId.split('/').at(-1).toLowerCase()!==BLOB_CONTRIBUTOR) throw new Error('source/cleanup role snapshot has the wrong role definition');
  } else if(value.effectiveRoleAssignments.some(item=>
    item.roleDefinitionId.split('/').at(-1).toLowerCase()===BLOB_CONTRIBUTOR||
    item.roleDefinitionId.split('/').at(-1).toLowerCase()===BLOB_READER||
    item.roleDefinitionId.split('/').at(-1).toLowerCase()===BLOB_OWNER)) {
    throw new Error('probe identity unexpectedly has a Blob read or write assignment');
  }
  return value;
}

/**
 * Azure ARM UAI provisioner for the U6/U8 candidate analogue.
 * `observeEffectiveAssignments` must be a separately authenticated, read-only
 * adapter that proves complete inherited/group/custom/dataActions/credential
 * resolution. This module never synthesizes that evidence.
 */
export function createAciRunScopedIdentityProvider({subscriptionId,resourceGroup,location,tenantId,
  getManagementToken,observeEffectiveAssignments,fetchImpl=fetch,now=()=>Date.now(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  pollIntervalMs=1000,timeoutMs=120000,identityApiVersion=API_IDENTITY,roleAssignmentApiVersion=API_RBAC}={}) {
  if(!GUID.test(subscriptionId||'')||!GUID.test(tenantId||'')||
    !/^[A-Za-z0-9_.()\-]{1,90}$/.test(resourceGroup||'')||typeof location!=='string'||!location||
    typeof getManagementToken!=='function'||typeof observeEffectiveAssignments!=='function'||typeof fetchImpl!=='function'||
    typeof now!=='function'||typeof sleep!=='function'||!Number.isInteger(pollIntervalMs)||pollIntervalMs<10||
    !Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>300000)
    throw new Error('invalid ACI run-scoped identity provider configuration');
  const created=new Map();

  async function request(url,method,body) {
    const token=await getManagementToken();
    if(typeof token!=='string'||!token||/\s/.test(token)) throw new Error('ACI identity ARM token unavailable');
    let response;
    try {response=await fetchImpl(url,{method,redirect:'error',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});} catch {throw new Error('ACI identity ARM request failed');}
    let value;try {value=await response.json();} catch {value={};}
    if(response.status===404) return {status:404,value};
    if(!response.ok) {
      const code=typeof value?.error?.code==='string'&&/^[A-Za-z0-9_.-]{1,80}$/.test(value.error.code)?value.error.code:'unknown';
      throw new Error(`ACI identity ARM ${method} failed (${response.status}, ${code})`);
    }
    return {status:response.status,value};
  }
  async function poll(url,predicate,stage) {
    const deadline=now()+timeoutMs;
    while(now()<deadline) {
      const result=await request(url,'GET');
      if(predicate(result)) return result;
      await sleep(Math.min(pollIntervalMs,Math.max(1,deadline-now())));
    }
    throw new Error(`ACI identity ${stage} timed out`);
  }
  const identityUrl=name=>`https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${encodeURIComponent(name)}?api-version=${identityApiVersion}`;
  const assignmentUrl=(scope,id)=>`https://management.azure.com${scope}/providers/Microsoft.Authorization/roleAssignments/${id}?api-version=${roleAssignmentApiVersion}`;
  const validateRequest=args=>{
    if(!args||!RUN.test(args.runId||'')||
      !['U6','U8'].includes(args.scenario)||!ROLES.has(args.role)||!CONTAINERS.has(args.container)||
      !args.target||typeof args.target.resourceId!=='string') throw new Error('invalid ACI run-scoped identity request');
    const match=ARM_SCOPE.exec(args.target.resourceId);
    if(!match||match[1].toLowerCase()!==subscriptionId.toLowerCase()||match[2].toLowerCase()!==resourceGroup.toLowerCase()||
      match[4].toLowerCase()!==args.container) throw new Error('identity target must be the configured Blob container in the configured subscription/resource group');
    return match;
  };

  async function removeCreated(resourceId,principalId,roleAssignmentId) {
    if(roleAssignmentId) {
      const scope=resourceId.targetResourceId;
      const url=assignmentUrl(scope,roleAssignmentId);
      const existing=await request(url,'GET');
      if(existing.status!==404) {
        await request(url,'DELETE');
        await poll(url,result=>result.status===404,'role-assignment deletion');
      }
    }
    if(resourceId.identityUrl) {
      const current=await request(resourceId.identityUrl,'GET');
      if(current.status!==404) {
        await request(resourceId.identityUrl,'DELETE');
        await poll(resourceId.identityUrl,result=>result.status===404,'identity deletion');
      }
    }
  }

  return Object.freeze({
    async createIdentity(args) {
      const match=validateRequest(args);
      const name=expectedName(args.runId,args.scenario,args.role);
      if(!SAFE_NAME.test(name)) throw new Error('invalid deterministic ACI identity name');
      const idUrl=identityUrl(name);
      const prior=await request(idUrl,'GET');
      if(prior.status!==404) throw new Error('deterministic ACI user-assigned identity already exists; refusing replay');
      const put=await request(idUrl,'PUT',{location,properties:{}});
      if(![200,201,202].includes(put.status)) throw new Error('ACI user-assigned identity creation was not accepted');
      let identityResource;
      try {
        const createdResult=await poll(idUrl,result=>result.status===200&&result.value?.properties?.provisioningState==='Succeeded'&&
          GUID.test(result.value?.properties?.principalId||'')&&GUID.test(result.value?.properties?.clientId||''),'creation');
        identityResource=createdResult.value;
        const objectId=identityResource.properties.principalId.toLowerCase();
        const clientId=identityResource.properties.clientId.toLowerCase();
        if(identityResource.id?.toLowerCase()!==`/subscriptions/${subscriptionId}/resourcegroups/${resourceGroup}/providers/microsoft.managedidentity/userassignedidentities/${name}`.toLowerCase()||
          identityResource.properties.tenantId?.toLowerCase()!==tenantId.toLowerCase()||
          !Number.isFinite(Date.parse(identityResource.systemData?.createdAt)))
          throw new Error('created ACI user-assigned identity lacks authoritative ARM metadata');
        let assignmentGuid,assignmentResourceId;
        if(args.role==='source'||args.role==='cleanup') {
          assignmentGuid=guidFromSeed(`${args.runId}|${args.scenario}|${args.role}|${objectId}|${args.target.resourceId}|${BLOB_CONTRIBUTOR}`);
          assignmentResourceId=`${args.target.resourceId}/providers/Microsoft.Authorization/roleAssignments/${assignmentGuid}`;
          const url=assignmentUrl(args.target.resourceId,assignmentGuid);
          const assignment=await request(url,'PUT',{properties:{roleDefinitionId:`/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${BLOB_CONTRIBUTOR}`,principalId:objectId,principalType:'ServicePrincipal'}});
          if(![200,201,202].includes(assignment.status)) throw new Error('container-scoped Blob role assignment was not accepted');
          const observed=await poll(url,result=>result.status===200&&
            result.value?.properties?.principalId?.toLowerCase()===objectId&&
            result.value?.properties?.roleDefinitionId?.split('/').at(-1).toLowerCase()===BLOB_CONTRIBUTOR&&
            result.value?.properties?.scope?.toLowerCase()===args.target.resourceId.toLowerCase(),'role assignment creation');
          if(observed.value?.id?.toLowerCase()!==assignmentResourceId.toLowerCase())
            throw new Error('role assignment ARM ID did not match the requested container scope');
        }
        const snapshot=await observeEffectiveAssignments({runId:args.runId,scenario:args.scenario,role:args.role,
          principalId:objectId,clientId,scope:args.target.resourceId,identityResourceId:identityResource.id});
        const review=validateSnapshot(snapshot,{runId:args.runId,principalId:objectId,role:args.role,
          targetResourceId:args.target.resourceId,assignmentId:assignmentResourceId});
        const result={objectId,clientId,resourceId:identityResource.id,runId:args.runId,role:args.role,
          created:true,createdAt:identityResource.systemData.createdAt,accessReview:{runId:review.runId,principalId:review.principalId,
            container:args.container,observerPrincipalId:review.observerPrincipalId,readMethod:review.readMethod,
            httpStatus:review.httpStatus,observedAt:review.observedAt,snapshotFingerprint:review.snapshotFingerprint,
            evidenceReference:review.evidenceReference,complete:review.complete,includesInherited:review.includesInherited,
            effectiveRoleAssignments:review.effectiveRoleAssignments.map(item=>({
              ...item,roleDefinitionId:item.roleDefinitionId.split('/').at(-1)
            }) )}};
        created.set(objectId,{identity:result,identityUrl:idUrl,targetResourceId:args.target.resourceId,assignmentId:assignmentGuid});
        return result;
      } catch(error) {
        try {await removeCreated({identityUrl:idUrl,targetResourceId:args.target.resourceId},identityResource?.properties?.principalId,
          (args.role==='source'||args.role==='cleanup')?guidFromSeed(`${args.runId}|${args.scenario}|${args.role}|${identityResource?.properties?.principalId?.toLowerCase()}|${args.target.resourceId}|${BLOB_CONTRIBUTOR}`):undefined);}
        catch {throw Object.assign(new Error('ACI identity creation failed and rollback could not be confirmed'),{cleanupIndeterminate:true});}
        throw error;
      }
    },
    async deleteIdentity({identity}) {
      const record=created.get(identity?.objectId?.toLowerCase());
      if(!record||record.identity.resourceId.toLowerCase()!==identity.resourceId?.toLowerCase()||record.identity.runId!==identity.runId||
        record.identity.role!==identity.role) throw new Error('refusing to delete an identity not created by this provider instance');
      await removeCreated({identityUrl:record.identityUrl,targetResourceId:record.targetResourceId},identity.objectId,record.assignmentId);
      const deleted={deleted:true,objectId:identity.objectId.toLowerCase(),roleAssignmentsRemoved:true,deletedAt:new Date(now()).toISOString()};
      created.delete(identity.objectId.toLowerCase());
      return deleted;
    }
  });
}

export {BLOB_CONTRIBUTOR as ACI_BLOB_DATA_CONTRIBUTOR_ROLE_ID};
