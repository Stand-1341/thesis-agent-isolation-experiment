import {createHash} from 'node:crypto';

const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BLOB_CONTRIBUTOR='ba92f5b4-2d11-453d-a403-e96b0029c9fe';
const ROLE_ASSIGNMENTS='/providers/Microsoft.Authorization/roleAssignments';

export function aciRunIdentityName(runId,scenario,role) {
  if(!/^pilot-[A-Za-z0-9_-]{1,140}$/.test(runId||'')||!['U6','U8'].includes(scenario)||!['source','probe','cleanup'].includes(role))
    throw new Error('invalid U6/U8 run identity tuple');
  const hash=createHash('sha256').update(`${runId}|${scenario}|${role}`).digest('hex').slice(0,32);
  return `aci-${hash}-${role}`;
}

export function buildAciRunIdentitySpecs(rows) {
  if(!Array.isArray(rows)||rows.length===0) throw new Error('a non-empty frozen schedule is required');
  const seen=new Set(),specs=[];
  for(const row of rows) {
    if(!row||!['U6','U8'].includes(row.scenario)||!/^pilot-[A-Za-z0-9_-]{1,140}$/.test(row.runId||''))
      throw new Error('invalid U6/U8 schedule row');
    const container=row.scenario==='U6'?'session-b':'prior-session';
    for(const role of ['source','probe','cleanup']) {
      const name=aciRunIdentityName(row.runId,row.scenario,role);
      if(seen.has(name)) throw new Error('duplicate run-scoped UAI name');
      seen.add(name);specs.push({name,runId:row.runId,scenario:row.scenario,role,container});
    }
  }
  return specs;
}

/** Build identity parameters from the exact frozen schedule bytes, without rewriting them. */
export function buildAciRunIdentityManifest(scheduleBytes,expectedSha256) {
  if(!Buffer.isBuffer(scheduleBytes)||! /^[a-f0-9]{64}$/i.test(expectedSha256||'')) throw new Error('schedule bytes and frozen SHA-256 are required');
  const actual=createHash('sha256').update(scheduleBytes).digest('hex');
  if(actual.toLowerCase()!==expectedSha256.toLowerCase()) throw new Error('frozen schedule digest mismatch; no identity manifest generated');
  const lines=scheduleBytes.toString('utf8').replace(/^\uFEFF/,'').trimEnd().split(/\r?\n/);
  const header=lines.shift()?.split(',');
  const runIndex=header?.indexOf('planned_run_id'),scenarioIndex=header?.indexOf('scenario_id');
  if(runIndex<0||scenarioIndex<0) throw new Error('frozen schedule lacks planned_run_id or scenario_id columns');
  const rows=lines.map(line=>{const values=line.split(',');return {runId:values[runIndex],scenario:values[scenarioIndex]};})
    .filter(row=>['U6','U8'].includes(row.scenario));
  return Object.freeze({scheduleSha256:actual,identitySpecs:buildAciRunIdentitySpecs(rows)});
}

export function attachAciIdentityPrincipalIds(manifest,identityRecords) {
  if(!manifest||! /^[a-f0-9]{64}$/i.test(manifest.scheduleSha256||'')||!Array.isArray(manifest.identitySpecs)||
    !Array.isArray(identityRecords))throw new Error('invalid identity manifest or Azure identity inventory');
  const ids=new Map();
  for(const row of identityRecords) {
    if(!row||typeof row.name!=='string'||!GUID.test(row.principalId||'')||ids.has(row.name))throw new Error('invalid or duplicate Azure identity principal record');
    ids.set(row.name,row.principalId.toLowerCase());
  }
  if(ids.size!==manifest.identitySpecs.length||manifest.identitySpecs.some(spec=>!ids.has(spec.name)))
    throw new Error('Azure identity inventory does not exactly match the frozen run manifest');
  return Object.freeze({...manifest,identitySpecs:manifest.identitySpecs.map(spec=>({...spec,principalId:ids.get(spec.name)}))});
}

function validateSnapshot(value,{runId,principalId,role,scope,assignmentId}) {
  if(!value||value.runId!==runId||value.principalId?.toLowerCase()!==principalId.toLowerCase()||value.status!=='complete'||
    value.complete!==true||value.includesInherited!==true||value.groupMembershipsResolved!==true||
    !Array.isArray(value.groupPrincipalIds)||value.groupPrincipalIds.length!==0||value.customRolesResolved!==true||
    value.dataActionsResolved!==true||value.indirectCredentialPathsResolved!==true||value.unknownRoleDefinitions?.length!==0||
    value.httpStatus!==200||value.readOnly!==true||value.readMethod!=='azure_role_assignments_effective_snapshot'||
    !GUID.test(value.observerPrincipalId||'')||value.observerPrincipalId.toLowerCase()===principalId.toLowerCase()||
    typeof value.evidenceReference!=='string'||!/^https:\/\/[^\s]{1,290}$/i.test(value.evidenceReference)||
    !/^sha256:[a-f0-9]{64}$/i.test(value.snapshotFingerprint||'')||!Number.isFinite(Date.parse(value.observedAt))||
    !Array.isArray(value.effectiveRoleAssignments)) throw new Error('independent Azure effective-role snapshot is incomplete or invalid');
  for(const item of value.effectiveRoleAssignments) if(!item||typeof item.assignmentId!=='string'||
    !item.assignmentId.includes(ROLE_ASSIGNMENTS+'/')||typeof item.scope!=='string'||
    typeof item.roleDefinitionId!=='string'||item.principalId?.toLowerCase()!==principalId.toLowerCase())
    throw new Error('effective-role snapshot contains an invalid assignment');
  const blob=value.effectiveRoleAssignments.filter(item=>item.roleDefinitionId.split('/').at(-1).toLowerCase()===BLOB_CONTRIBUTOR);
  if(role==='probe'&&blob.length) throw new Error('probe identity unexpectedly has Blob Data Contributor access');
  if(role!=='probe'&&(blob.length!==1||blob[0].scope.toLowerCase()!==scope.toLowerCase()||blob[0].assignmentId.toLowerCase()!==assignmentId?.toLowerCase()))
    throw new Error('source/cleanup identity lacks its exact container-scoped Blob Data Contributor assignment');
  return value;
}

/**
 * Runtime adapter for identities provisioned ahead of time by the dedicated
 * Bicep template. It never creates identities or role grants. Observer callback
 * is independently credentialed and must resolve inherited/effective access.
 */
export function createAciPreprovisionedIdentityProvider({subscriptionId,resourceGroup,tenantId,location,
  controllerPrincipalId,identityLifecycleRoleDefinitionId,identityInventory,roleAssignmentAdminRoleId='f58310d9-a9f6-439a-9e8d-f62e7b41a168',
  getManagementToken,observeEffectiveAssignments,fetchImpl=fetch,now=()=>Date.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms)),
  pollIntervalMs=1000,timeoutMs=120000,roleAssignmentApiVersion='2022-04-01',identityApiVersion='2023-01-31'}={}) {
  if(!GUID.test(subscriptionId||'')||!GUID.test(tenantId||'')||!resourceGroup||!location||
    !GUID.test(controllerPrincipalId||'')||typeof identityLifecycleRoleDefinitionId!=='string'||
    !Array.isArray(identityInventory)||identityInventory.length!==30||
    typeof getManagementToken!=='function'||typeof observeEffectiveAssignments!=='function'||typeof fetchImpl!=='function')
    throw new Error('invalid preprovisioned ACI identity provider configuration');
  const claimed=new Map();
  const inventory=new Map();
  for(const item of identityInventory) {
    if(!item||typeof item.name!=='string'||!GUID.test(item.principalId||'')||inventory.has(item.name))
      throw new Error('invalid or duplicate deployed 30-identity inventory');
    inventory.set(item.name,item.principalId.toLowerCase());
  }
  const root=`https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}`;
  async function request(url,method='GET',body) {
    const token=await getManagementToken();if(typeof token!=='string'||!token||/\s/.test(token)) throw new Error('ACI identity ARM token unavailable');
    let response;try {response=await fetchImpl(url,{method,redirect:'error',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});} catch {throw new Error('ACI identity ARM request failed');}
    let value;try {value=await response.json();} catch {value={};}
    if(response.status===404)return {status:404,value};
    if(!response.ok)throw new Error(`ACI identity ARM ${method} failed (${response.status})`);
    return {status:response.status,value};
  }
  async function pollAbsent(url) {const end=now()+timeoutMs;while(now()<end){if((await request(url)).status===404)return;await sleep(Math.min(pollIntervalMs,end-now()));}throw new Error('ACI identity cleanup timed out');}
  const identityUrl=name=>`${root}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${encodeURIComponent(name)}?api-version=${identityApiVersion}`;
  return Object.freeze({
    async createIdentity(args) {
      if(!args||!['session-b','prior-session'].includes(args.container)||
        (args.scenario==='U6'&&args.container!=='session-b')||(args.scenario==='U8'&&args.container!=='prior-session'))
        throw new Error('identity container does not match the U6/U8 schedule');
      const name=aciRunIdentityName(args.runId,args.scenario,args.role),url=identityUrl(name);
      const expectedPrincipal=inventory.get(name);
      if(!expectedPrincipal) throw new Error('scheduled identity is absent from the deployed 30-identity inventory');
      if(claimed.has(name))throw new Error('preprovisioned identity already claimed in this provider instance');
      const read=await request(url);if(read.status===404)throw new Error('required run-scoped UAI is not preprovisioned');
      const arm=read.value,principalId=arm?.properties?.principalId?.toLowerCase(),clientId=arm?.properties?.clientId?.toLowerCase();
      const expected=`/subscriptions/${subscriptionId}/resourcegroups/${resourceGroup}/providers/microsoft.managedidentity/userassignedidentities/${name}`;
      if(arm?.id?.toLowerCase()!==expected||arm?.properties?.tenantId?.toLowerCase()!==tenantId.toLowerCase()||
        arm?.location?.toLowerCase()!==location.toLowerCase()||arm?.properties?.provisioningState!=='Succeeded'||
        !GUID.test(principalId||'')||principalId!==expectedPrincipal||!GUID.test(clientId||'')||!Number.isFinite(Date.parse(arm.systemData?.createdAt)))
        throw new Error('preprovisioned UAI ARM metadata does not match expected identity');
      const target=args.target?.resourceId;
      if(typeof target!=='string'||!target.toLowerCase().endsWith(`/containers/${args.container}`))throw new Error('invalid marker container scope');
      const snapshot=await observeEffectiveAssignments({runId:args.runId,scenario:args.scenario,role:args.role,
        principalId,clientId,scope:target,identityResourceId:arm.id});
      const roleAssignment=snapshot?.effectiveRoleAssignments?.find(item=>item.roleDefinitionId.split('/').at(-1).toLowerCase()===BLOB_CONTRIBUTOR);
      const review=validateSnapshot(snapshot,{runId:args.runId,principalId,role:args.role,scope:target,assignmentId:roleAssignment?.assignmentId});
      const identity={objectId:principalId,clientId,resourceId:arm.id,runId:args.runId,role:args.role,created:true,
        createdAt:arm.systemData.createdAt,
        accessReview:{runId:review.runId,principalId:review.principalId,container:args.container,
          observerPrincipalId:review.observerPrincipalId,readMethod:review.readMethod,httpStatus:review.httpStatus,
          observedAt:review.observedAt,snapshotFingerprint:review.snapshotFingerprint,evidenceReference:review.evidenceReference,
          complete:review.complete,includesInherited:review.includesInherited,effectiveRoleAssignments:review.effectiveRoleAssignments.map(x=>({...x,roleDefinitionId:x.roleDefinitionId.split('/').at(-1)}))}};
      claimed.set(name,{identity,url,target,assignmentIds:review.effectiveRoleAssignments.map(x=>x.assignmentId)});
      return identity;
    },
    async deleteIdentity({identity}) {
      const name=aciRunIdentityName(identity?.runId,identity?.accessReview?.container==='session-b'?'U6':'U8',identity?.role);
      const record=claimed.get(name);
      if(!record||record.identity.objectId!==identity?.objectId||record.identity.resourceId.toLowerCase()!==identity?.resourceId?.toLowerCase())
        throw new Error('refusing to delete an identity not claimed by this provider instance');
      // Bicep grants only the exact Blob role-assignment deletes and identity
      // delete/assign action at this identity's ARM scope.
      for(const id of record.assignmentIds) {
        const prefix=`${record.target}${ROLE_ASSIGNMENTS}/`;
        if(!id.toLowerCase().startsWith(prefix.toLowerCase()))throw new Error('refusing out-of-container role assignment deletion');
        const url=`https://management.azure.com${id}?api-version=${roleAssignmentApiVersion}`;
        if((await request(url)).status!==404){await request(url,'DELETE');await pollAbsent(url);}
      }
      const scope=record.identity.resourceId;
      const list=await request(`https://management.azure.com${scope}${ROLE_ASSIGNMENTS}?api-version=${roleAssignmentApiVersion}`);
      if(!Array.isArray(list.value?.value))throw new Error('identity-scope role assignments could not be listed for safe cleanup');
      const ownBootstrapGrants=list.value.value.filter(item=>item.properties?.principalId?.toLowerCase()===controllerPrincipalId.toLowerCase()&&
        [identityLifecycleRoleDefinitionId.split('/').at(-1).toLowerCase(),roleAssignmentAdminRoleId.toLowerCase()]
          .includes(item.properties?.roleDefinitionId?.split('/').at(-1).toLowerCase()))
        .sort((a,b)=>a.properties.roleDefinitionId.toLowerCase().includes(identityLifecycleRoleDefinitionId.split('/').at(-1).toLowerCase())?-1:1);
      for(const item of ownBootstrapGrants) {
        if(typeof item.id!=='string'||!item.id.toLowerCase().startsWith(`${scope}${ROLE_ASSIGNMENTS}/`.toLowerCase()))
          throw new Error('refusing to delete out-of-scope identity role assignment');
        const url=`https://management.azure.com${item.id}?api-version=${roleAssignmentApiVersion}`;
        await request(url,'DELETE');await pollAbsent(url);
      }
      const current=await request(record.url);if(current.status!==404){await request(record.url,'DELETE');await pollAbsent(record.url);}
      claimed.delete(name);return {deleted:true,objectId:identity.objectId,roleAssignmentsRemoved:true,deletedAt:new Date(now()).toISOString()};
    }
  });
}
