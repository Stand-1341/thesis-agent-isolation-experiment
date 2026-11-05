/**
 * Read-only, fail-closed Azure RBAC review for a run-scoped service principal.
 *
 * The reviewer queries effective role assignments at the Blob container scope,
 * transitive service-principal group membership, role definitions, and deny
 * assignments. It only returns `complete` when every page succeeds, role
 * definitions and data actions are understood, no conditional assignment or
 * unresolved group/deny path exists, and no non-read control-plane action can
 * create an alternate credential/access path. A complete result is still a
 * time-bounded ARM/Graph snapshot; it is not a live data-plane authorization
 * oracle. The caller must supply a separately credentialed evidence writer.
 */
import {createHash} from 'node:crypto';

const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN=/^[A-Za-z0-9_-]{1,150}$/;
const CONTAINER_ARM=/^\/subscriptions\/([0-9a-f-]{36})\/resourceGroups\/([A-Za-z0-9._()-]+)\/providers\/Microsoft\.Storage\/storageAccounts\/([a-z0-9]{3,24})\/blobServices\/default\/containers\/([a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9]))$/i;
const REF=/^(https:\/\/|urn:|file:)[^\r\n]{1,290}$/i;
const API='2022-04-01';
const BLOB_READ='Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read';
const BLOB_WRITE='Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write';
const BLOB_DATA_CONTRIBUTOR='ba92f5b4-2d11-453d-a403-e96b0029c9fe';
const CONTRIBUTOR_ACTIONS=[
  'Microsoft.Storage/storageAccounts/blobServices/containers/delete',
  'Microsoft.Storage/storageAccounts/blobServices/containers/read',
  'Microsoft.Storage/storageAccounts/blobServices/containers/write',
  'Microsoft.Storage/storageAccounts/blobServices/generateUserDelegationKey/action'
].sort();
const CONTRIBUTOR_DATA_ACTIONS=[
  'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action',
  'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/delete',
  'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/move/action',
  BLOB_READ,BLOB_WRITE
].sort();
const ALL_PRINCIPALS='00000000-0000-0000-0000-000000000000';
const MAX_PAGES=300,MAX_ITEMS=20000;

function validRef(value) {return typeof value==='string'&&REF.test(value);}
function sortDeep(value) {
  if(Array.isArray(value)) return value.map(sortDeep);
  if(value&&typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(key=>[key,sortDeep(value[key])]));
  return value;
}
function canonical(value) {return JSON.stringify(sortDeep(value));}
function digest(value) {return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;}
function actionMatches(pattern,action) {
  if(typeof pattern!=='string'||!pattern) return false;
  const escaped=pattern.split('*').map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*');
  return new RegExp(`^${escaped}$`,'i').test(action);
}
function allows(actions,notActions,action) {
  return Array.isArray(actions)&&actions.some(item=>actionMatches(item,action))&&
    !(Array.isArray(notActions)&&notActions.some(item=>actionMatches(item,action)));
}
function normalizedScope(value) {return String(value||'').replace(/\/$/,'').toLowerCase();}
function scopeApplies(assignmentScope,targetScope) {
  const scope=normalizedScope(assignmentScope),target=normalizedScope(targetScope);
  // Subscription and resource-group parents are prefix scopes. Management
  // group paths are not derivable from the target ARM id here, so they remain
  // unresolved instead of being guessed applicable or irrelevant.
  return scope===target||target.startsWith(`${scope}/`);
}
function isChildScope(scope,targetScope) {
  return normalizedScope(scope).startsWith(`${normalizedScope(targetScope)}/`);
}
function validateUrl(url,host) {
  let parsed;try {parsed=new URL(url);} catch {throw new Error('Azure access review returned an invalid continuation URL');}
  if(parsed.protocol!=='https:'||parsed.hostname.toLowerCase()!==host||parsed.username||parsed.password)
    throw new Error('Azure access review continuation escaped its trusted API host');
  return parsed.href;
}
async function readPages({url,host,token,fetchImpl,limit=MAX_ITEMS}) {
  const values=[],seen=new Set();let next=validateUrl(url,host),pageCount=0;
  while(next) {
    if(seen.has(next)||++pageCount>MAX_PAGES) throw new Error('Azure access review pagination is incomplete');
    seen.add(next);
    let response;try {response=await fetchImpl(next,{method:'GET',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},redirect:'error',signal:AbortSignal.timeout(30000)});} catch {throw new Error('Azure access review API request failed');}
    if(response.status!==200) throw new Error(`Azure access review API returned HTTP ${response.status}`);
    let body;try {body=await response.json();} catch {throw new Error('Azure access review API returned invalid JSON');}
    if(!body||!Array.isArray(body.value)) throw new Error('Azure access review API response omitted its result collection');
    values.push(...body.value);
    if(values.length>limit) throw new Error('Azure access review exceeded its bounded result limit');
    const continuation=body.nextLink??body['@odata.nextLink'];
    next=continuation?validateUrl(continuation,host):undefined;
  }
  return values;
}
function rolePermissions(definition) {
  const permissions=definition?.properties?.permissions;
  if(!Array.isArray(permissions)||permissions.length===0) throw new Error('Azure role definition has no readable permissions');
  const result={actions:[],notActions:[],dataActions:[],notDataActions:[]};
  for(const item of permissions) for(const key of Object.keys(result)) {
    if(item?.[key]===undefined) continue;
    if(!Array.isArray(item[key])||!item[key].every(value=>typeof value==='string')) throw new Error('Azure role permission fields are incomplete');
    result[key].push(...item[key]);
  }
  return result;
}
function listOfStrings(value) {return Array.isArray(value)&&value.every(item=>typeof item==='string');}
function validAssignment(item) {
  const p=item?.properties;
  return typeof item?.id==='string'&&item.id.includes('/providers/Microsoft.Authorization/roleAssignments/')&&
    GUID.test(p?.principalId||'')&&GUID.test(String(p?.roleDefinitionId||'').split('/').at(-1)||'')&&
    typeof p?.scope==='string'&&p.scope.startsWith('/')&&
    (p.condition===undefined||p.condition===null||typeof p.condition==='string')&&
    (p.delegatedManagedIdentityResourceId===undefined||p.delegatedManagedIdentityResourceId===null||typeof p.delegatedManagedIdentityResourceId==='string');
}
function validDeny(item) {
  const p=item?.properties;
  return typeof item?.id==='string'&&typeof p?.scope==='string'&&p.scope.startsWith('/')&&
    Array.isArray(p?.principals)&&Array.isArray(p?.excludePrincipals)&&Array.isArray(p?.permissions)&&
    p.permissions.every(permission=>listOfStrings(permission?.dataActions)&&listOfStrings(permission?.notDataActions));
}
function denyApplies(deny,principalId,groups,targetScope) {
  const p=deny.properties;
  if(!scopeApplies(p.scope,targetScope)||(normalizedScope(p.scope)!==normalizedScope(targetScope)&&p.doNotApplyToChildScopes===true)) return false;
  const set=new Set([principalId,...groups]);
  const included=p.principals.some(item=>item?.type==='AllPrincipals'||item?.id===ALL_PRINCIPALS||set.has(String(item?.id||'').toLowerCase()));
  const excluded=p.excludePrincipals.some(item=>item?.type==='AllPrincipals'||item?.id===ALL_PRINCIPALS||set.has(String(item?.id||'').toLowerCase()));
  return included&&!excluded;
}
function permissionList(permissions,key) {
  const values=[];
  for(const item of permissions||[]) {
    if(!Array.isArray(item?.[key])) throw new Error('Azure deny assignment permission fields are incomplete');
    values.push(...item[key]);
  }
  return values;
}
function exactBlobContributor(permission) {
  const sorted=value=>[...value].sort();
  return JSON.stringify(sorted(permission.actions))===JSON.stringify(CONTRIBUTOR_ACTIONS)&&
    JSON.stringify(sorted(permission.notActions))==='[]'&&
    JSON.stringify(sorted(permission.dataActions))===JSON.stringify(CONTRIBUTOR_DATA_ACTIONS)&&
    JSON.stringify(sorted(permission.notDataActions))==='[]';
}
function mayCreateIndirectCredentialPath(rolePerms,{roleDefinitionId,scope,targetScope}) {
  // For this pilot, control-plane allow rules must be read-only and data-plane
  // grants must be limited to Blob read/write in the target container. We do
  // not claim a complete credential-path analysis for arbitrary Azure roles.
  // Storage Blob Data Contributor is the one source-side role explicitly
  // allowed by the analogue. At the exact container scope its built-in
  // container metadata actions do not grant the account-level listKeys or
  // delegation-key actions needed to mint a credential. Broader scopes or
  // custom roles are not inferred equivalent.
  if(String(roleDefinitionId).split('/').at(-1).toLowerCase()===BLOB_DATA_CONTRIBUTOR&&
    normalizedScope(scope)===normalizedScope(targetScope)&&exactBlobContributor(rolePerms)) return false;
  if(rolePerms.actions.some(action=>!/^([^*]+\/)?read$/i.test(action)&&action!=='*/read')) return true;
  const permittedData=/^Microsoft\.Storage\/storageAccounts\/blobServices\/containers\/blobs\/(?:read|write|delete|add\/action|move\/action)$/i;
  return rolePerms.dataActions.some(action=>!permittedData.test(action))||
    rolePerms.notActions.some(action=>action==='*')||rolePerms.notDataActions.some(action=>action==='*');
}
function limitedAssignment(item,principalId) {
  return {assignmentId:item.id,roleDefinitionId:item.properties.roleDefinitionId,scope:item.properties.scope,principalId};
}
function errorWithEvidence(message,partialEvidence) {
  const error=new Error(message);error.partialEvidence=partialEvidence;return error;
}

export function createAzureEffectiveBlobAccessReviewer({getManagementToken,getGraphToken,observerPrincipalId,
  reviewCredentialPaths,persistSnapshot,fetchImpl=fetch,now=()=>Date.now()}={}) {
  if(typeof getManagementToken!=='function'||typeof getGraphToken!=='function'||typeof persistSnapshot!=='function'||
    typeof reviewCredentialPaths!=='function'||typeof fetchImpl!=='function'||typeof now!=='function'||!GUID.test(observerPrincipalId||''))
    throw new Error('Azure Blob access reviewer requires separate ARM/Graph tokens, an observer, an independent credential-path reviewer, and protected snapshot storage');

  async function runReview({principalId,identityResourceId,runId,scenario,container,targetResourceId}) {
    if(!GUID.test(principalId||'')||!RUN.test(runId||'')||!['U6','U8'].includes(scenario)||!['session-b','prior-session'].includes(container)||
      !CONTAINER_ARM.test(targetResourceId||'')) throw new Error('invalid Azure Blob access review target');
    const armToken=await getManagementToken(),graphToken=await getGraphToken();
    if(typeof armToken!=='string'||armToken.length<20||/\s/.test(armToken)||typeof graphToken!=='string'||graphToken.length<20||/\s/.test(graphToken))
      throw new Error('Azure Blob access review token unavailable');
    const observedAt=new Date(now()).toISOString();
    const snapshot={schema:'azure-effective-blob-access-review-v1',runId,scenario,principalId:principalId.toLowerCase(),container,
      resourceId:targetResourceId,observerPrincipalId:observerPrincipalId.toLowerCase(),observedAt,
      roleAssignments:[],roleDefinitions:[],transitiveGroups:[],denyAssignments:[],unresolved:[]};
    let groups=[],hasBlobRead=false,hasBlobWrite=false,assignments=[];
    try {
      const groupUrl=`https://graph.microsoft.com/v1.0/servicePrincipals/${encodeURIComponent(principalId)}/transitiveMemberOf?$select=id`;
      groups=await readPages({url:groupUrl,host:'graph.microsoft.com',token:graphToken,fetchImpl,limit:5000});
      if(groups.some(group=>!GUID.test(group?.id||'')||!String(group?.['@odata.type']||'').endsWith('.group')))
        throw new Error('Graph group membership did not return a complete typed service-principal membership set');
      snapshot.transitiveGroups=groups.map(group=>group.id.toLowerCase()).sort();

      const assignmentUrl=`https://management.azure.com${targetResourceId}/providers/Microsoft.Authorization/roleAssignments?api-version=${API}&%24filter=${encodeURIComponent(`assignedTo('${principalId}')`)}`;
      const rawAssignments=await readPages({url:assignmentUrl,host:'management.azure.com',token:armToken,fetchImpl});
      if(rawAssignments.some(item=>!validAssignment(item))) throw new Error('role assignment snapshot contains malformed records');
      const groupSet=new Set(snapshot.transitiveGroups);
      if(rawAssignments.some(item=>!scopeApplies(item.properties.scope,targetResourceId)&&!isChildScope(item.properties.scope,targetResourceId)))
        throw new Error('inherited role assignment scope is not provably on the target resource ancestry');
      const relevant=rawAssignments.filter(item=>scopeApplies(item.properties.scope,targetResourceId));
      for(const item of relevant) {
        const p=item.properties,assignedPrincipal=p.principalId.toLowerCase();
        if(assignedPrincipal!==principalId.toLowerCase()&&!groupSet.has(assignedPrincipal))
          throw new Error('ARM returned a role assignment whose principal is outside the reviewed service principal/group set');
        if(p.condition||p.conditionVersion||p.delegatedManagedIdentityResourceId)
          throw new Error('conditional or delegated-managed-identity role assignment is not evaluated by this reviewer');
      }
      assignments=relevant;
      snapshot.roleAssignments=relevant.map(item=>({id:item.id,principalId:item.properties.principalId.toLowerCase(),
        principalType:item.properties.principalType||'unknown',roleDefinitionId:item.properties.roleDefinitionId,
        scope:item.properties.scope,condition:item.properties.condition||null,
        delegatedManagedIdentityResourceId:item.properties.delegatedManagedIdentityResourceId||null}));

      const roleIds=[...new Set(relevant.map(item=>item.properties.roleDefinitionId))];
      const definitions=new Map();
      for(const roleDefinitionId of roleIds) {
        const roleGuid=String(roleDefinitionId).split('/').at(-1);
        if(!GUID.test(roleGuid)) throw new Error('role definition ID is invalid');
        const definitionUrl=`https://management.azure.com${roleDefinitionId}?api-version=${API}`;
        let response;try {response=await fetchImpl(validateUrl(definitionUrl,'management.azure.com'),{method:'GET',headers:{authorization:`Bearer ${armToken}`},redirect:'error',signal:AbortSignal.timeout(30000)});} catch {throw new Error('role definition lookup failed');}
        if(response.status!==200) throw new Error(`role definition lookup returned HTTP ${response.status}`);
        let body;try {body=await response.json();} catch {throw new Error('role definition response is invalid');}
        const permissions=rolePermissions(body);definitions.set(roleDefinitionId,permissions);
        snapshot.roleDefinitions.push({id:roleDefinitionId,roleName:body?.properties?.roleName||null,permissions});
      }

      const denyUrl=`https://management.azure.com${targetResourceId}/providers/Microsoft.Authorization/denyAssignments?api-version=${API}&%24filter=${encodeURIComponent(`assignedTo('${principalId}')`)}`;
      const denyAssignments=await readPages({url:denyUrl,host:'management.azure.com',token:armToken,fetchImpl});
      if(denyAssignments.some(item=>!validDeny(item))) throw new Error('deny assignment snapshot contains malformed records');
      if(denyAssignments.some(item=>!scopeApplies(item.properties.scope,targetResourceId)&&!isChildScope(item.properties.scope,targetResourceId)))
        throw new Error('deny-assignment scope is not provably on the target resource ancestry');
      snapshot.denyAssignments=denyAssignments.filter(item=>scopeApplies(item.properties.scope,targetResourceId)).map(item=>({
        id:item.id,scope:item.properties.scope,principals:item.properties.principals,excludePrincipals:item.properties.excludePrincipals,
        permissions:item.properties.permissions,doNotApplyToChildScopes:item.properties.doNotApplyToChildScopes,
        condition:item.properties.condition||null}));
      if(snapshot.denyAssignments.some(item=>item.condition)) throw new Error('conditional deny assignment is not evaluated by this reviewer');

      let indirectResolved=true;
      for(const item of relevant) {
        const principal=item.properties.principalId.toLowerCase();
        const permission=definitions.get(item.properties.roleDefinitionId);
        if(!permission) throw new Error('role definition was not resolved');
        if(mayCreateIndirectCredentialPath(permission,{roleDefinitionId:item.properties.roleDefinitionId,
          scope:item.properties.scope,targetScope:targetResourceId})) indirectResolved=false;
        if(principal!==principalId.toLowerCase()&&
          (permission.dataActions.some(action=>actionMatches(action,BLOB_READ)||actionMatches(action,BLOB_WRITE))||!indirectResolved))
          throw new Error('group-based role access cannot be represented faithfully in the session analogue evidence schema');
        const applicableScope=scopeApplies(item.properties.scope,targetResourceId);
        if(!applicableScope) continue;
        if(principal===principalId.toLowerCase()) {
          if(allows(permission.dataActions,permission.notDataActions,BLOB_READ)) hasBlobRead=true;
          if(allows(permission.dataActions,permission.notDataActions,BLOB_WRITE)) hasBlobWrite=true;
        }
      }
      if(!indirectResolved) throw new Error('non-read control-plane or non-Blob data actions leave indirect credential paths unresolved');

      for(const deny of denyAssignments) {
        if(!denyApplies(deny,principalId.toLowerCase(),groupSet,targetResourceId)) continue;
        const denyRead=permissionList(deny.properties.permissions,'dataActions');
        const denyNotRead=permissionList(deny.properties.permissions,'notDataActions');
        if(allows(denyRead,denyNotRead,BLOB_READ)) hasBlobRead=false;
        if(allows(denyRead,denyNotRead,BLOB_WRITE)) hasBlobWrite=false;
      }

      // ARM/Graph role data cannot prove that the UAI has no alternate
      // credential source (or that a container exposes only approved
      // identities). Require a separately credentialed observer to attest
      // that complete boundary. This callback runs in pre-group identity
      // review; the later ACI observer must still independently verify the
      // actual group identity attachments during creation.
      const credentialReview=await reviewCredentialPaths({principalId:principalId.toLowerCase(),runId,container,
        identityResourceId, targetResourceId,observerPrincipalId:observerPrincipalId.toLowerCase(),phase:'identity_pre_group'});
      if(!credentialReview||credentialReview.status!=='complete'||credentialReview.source!=='azure_live_identity_credential_path_review_v1'||
        credentialReview.runId!==runId||credentialReview.principalId?.toLowerCase()!==principalId.toLowerCase()||
        credentialReview.container!==container||credentialReview.resourceId?.toLowerCase()!==targetResourceId.toLowerCase()||
        credentialReview.observerPrincipalId?.toLowerCase()!==observerPrincipalId.toLowerCase()||
        credentialReview.observerPrincipalId.toLowerCase()===principalId.toLowerCase()||credentialReview.readOnly!==true||
        credentialReview.allPathsResolved!==true||!Array.isArray(credentialReview.unresolvedPaths)||credentialReview.unresolvedPaths.length!==0||
        !validRef(credentialReview.evidenceReference)||!/^sha256:[a-f0-9]{64}$/i.test(credentialReview.snapshotFingerprint||'')||
        !Number.isFinite(Date.parse(credentialReview.observedAt)))
        throw new Error('independent identity credential-path review is incomplete');
      snapshot.credentialPathReview={source:credentialReview.source,observerPrincipalId:credentialReview.observerPrincipalId,
        evidenceReference:credentialReview.evidenceReference,snapshotFingerprint:credentialReview.snapshotFingerprint,
        observedAt:credentialReview.observedAt,allPathsResolved:true,unresolvedPaths:[]};

      const snapshotFingerprint=digest(snapshot);
      const persisted=await persistSnapshot({snapshot,snapshotFingerprint});
      const evidenceReference=typeof persisted==='string'?persisted:persisted?.reference;
      if(!validRef(evidenceReference)) throw new Error('protected RBAC snapshot writer returned no valid evidence reference');
      const directEffective=assignments.filter(item=>item.properties.principalId.toLowerCase()===principalId.toLowerCase())
        .filter(item=>scopeApplies(item.properties.scope,targetResourceId)).map(item=>limitedAssignment(item,principalId.toLowerCase()));
      return {status:'complete',runId,principalId:principalId.toLowerCase(),container,resourceId:targetResourceId,
        source:'azure_live_effective_access_evaluator_v1',httpStatus:200,readOnly:true,observerPrincipalId:observerPrincipalId.toLowerCase(),
        evidenceReference,snapshotFingerprint,observedAt,inheritanceResolved:true,groupMembershipsResolved:true,
        groupPrincipalIds:[...snapshot.transitiveGroups],customRolesResolved:true,dataActionsResolved:true,conditionsResolved:true,denyAssignmentsResolved:true,
        indirectCredentialPathsResolved:true,unknownRoleDefinitions:[],hasBlobRead,hasBlobWrite,effectiveAssignments:snapshot.roleAssignments,
        effectiveRoleAssignments:directEffective};
    } catch(error) {
      snapshot.unresolved.push(error instanceof Error?error.message:'review failed');
      const snapshotFingerprint=digest(snapshot);
      let evidenceReference;
      try {
        const persisted=await persistSnapshot({snapshot,snapshotFingerprint});
        evidenceReference=typeof persisted==='string'?persisted:persisted?.reference;
      } catch {}
      const partial={scope:'azure_effective_blob_access_review',status:'incomplete',runId,principalId:principalId.toLowerCase(),container,
        resourceId:targetResourceId,observerPrincipalId:observerPrincipalId.toLowerCase(),snapshotFingerprint,observedAt,
        ...(validRef(evidenceReference)?{evidenceReference}:{}),unresolved:[...snapshot.unresolved]};
      throw errorWithEvidence('Azure effective Blob access review is incomplete; fail closed',partial);
    }
  }

  return Object.freeze({
    async reviewIdentityAccess({identity,runId,scenario,container,targetResourceId}) {
      const result=await runReview({principalId:identity?.objectId,identityResourceId:identity?.resourceId,runId,scenario,container,targetResourceId});
      return {status:'complete',runId:result.runId,principalId:result.principalId,container,observerPrincipalId:result.observerPrincipalId,
        readMethod:'azure_role_assignments_effective_snapshot',httpStatus:200,observedAt:result.observedAt,
        snapshotFingerprint:result.snapshotFingerprint,evidenceReference:result.evidenceReference,
        complete:true,includesInherited:true,groupMembershipsResolved:true,groupPrincipalIds:result.groupPrincipalIds,
        unknownRoleDefinitions:result.unknownRoleDefinitions,effectiveRoleAssignments:result.effectiveRoleAssignments};
    },
    evaluateEffectiveAccess:({identity,runId,scenario,container,targetResourceId})=>
      runReview({principalId:identity?.objectId,identityResourceId:identity?.resourceId,runId,scenario,container,targetResourceId})
  });
}

