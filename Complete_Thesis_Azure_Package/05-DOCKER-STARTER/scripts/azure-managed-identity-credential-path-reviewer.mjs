/**
 * Read-only Entra review of credential paths for an Azure managed identity.
 *
 * Graph proves the service-principal type, credential collections, owners,
 * transitive group membership, and application permission grants. Azure RBAC
 * attachment paths are delegated to a separately authenticated ARM reviewer;
 * without that review this module always returns incomplete.
 */
import {createHash} from 'node:crypto';

const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN=/^[A-Za-z0-9_-]{1,150}$/;
const REF=/^(https:\/\/|urn:|file:)[^\r\n]{1,290}$/i;
const UAI=/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9._()-]+\/providers\/Microsoft\.ManagedIdentity\/userAssignedIdentities\/[A-Za-z0-9._()-]+$/i;
const GRAPH='https://graph.microsoft.com/v1.0';
const SOURCE='azure_live_identity_credential_path_review_v1';

function sortDeep(value) {
  if(Array.isArray(value)) return value.map(sortDeep);
  if(value&&typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(key=>[key,sortDeep(value[key])]));
  return value;
}
function fingerprint(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(sortDeep(value)),'utf8').digest('hex')}`;
}

export function createAzureManagedIdentityCredentialPathReviewer({getGraphToken,observerPrincipalId,
  persistSnapshot,reviewAzureAttachPaths,fetchImpl=fetch,now=()=>Date.now()}={}) {
  if(typeof getGraphToken!=='function'||typeof persistSnapshot!=='function'||!GUID.test(observerPrincipalId||'')||
    typeof fetchImpl!=='function'||typeof now!=='function')
    throw new Error('managed-identity credential reviewer requires Graph, a separate observer, and protected snapshot storage');

  async function graphJson(url,token) {
    const parsed=new URL(url);
    if(parsed.origin!=='https://graph.microsoft.com') throw new Error('Graph pagination left the Microsoft Graph host');
    let response;
    try {response=await fetchImpl(parsed.href,{method:'GET',headers:{authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(20000)});}
    catch {throw new Error('Microsoft Graph credential-path request failed');}
    if(!response.ok) throw new Error(`Microsoft Graph credential-path request returned HTTP ${response.status}`);
    try {return await response.json();} catch {throw new Error('Microsoft Graph credential-path response was invalid');}
  }

  async function graphPages(url,token) {
    const values=[];let next=url,pages=0;
    while(next) {
      if(++pages>100||values.length>10000) throw new Error('Microsoft Graph credential-path inventory exceeded its safety bound');
      const body=await graphJson(next,token);
      if(!Array.isArray(body?.value)) throw new Error('Microsoft Graph credential-path page omitted its value array');
      values.push(...body.value);next=body['@odata.nextLink']||null;
    }
    return values;
  }

  return async function review({principalId,identityResourceId,runId,scenario,container,targetResourceId}={}) {
    const unresolved=[];
    const result={status:'incomplete',source:SOURCE,runId,principalId,container,resourceId:targetResourceId,
      observerPrincipalId:observerPrincipalId.toLowerCase(),readOnly:true,allPathsResolved:false,unresolvedPaths:unresolved};
    if(!GUID.test(principalId||'')||!UAI.test(identityResourceId||'')||!RUN.test(runId||'')||
      !['U6','U8'].includes(scenario)||!['session-b','prior-session'].includes(container)||
      !String(targetResourceId||'').toLowerCase().endsWith(`/containers/${container}`)) {
      unresolved.push('managed_identity_review_scope_invalid');return result;
    }

    const snapshot={schema:'azure_identity_credential_path_review_v1',runId,scenario,principalId:principalId.toLowerCase(),
      identityResourceId,container,resourceId:targetResourceId,observerPrincipalId:observerPrincipalId.toLowerCase(),
      observedAt:new Date(now()).toISOString(),servicePrincipal:null,owners:[],transitiveGroups:[],appRoleAssignments:[],
      delegatedPermissionGrants:[],azureAttachPathReview:null,unresolvedPaths:unresolved};
    let token;
    try {token=await getGraphToken();} catch {unresolved.push('graph_token_unavailable');return persistResult(snapshot,result);}
    if(typeof token!=='string'||token.length<20||/[\r\n]/.test(token)) {
      unresolved.push('graph_token_invalid');return persistResult(snapshot,result);
    }
    try {
      const select='id,appId,servicePrincipalType,accountEnabled,alternativeNames,keyCredentials,passwordCredentials';
      const sp=await graphJson(`${GRAPH}/servicePrincipals/${encodeURIComponent(principalId)}?$select=${select}`,token);
      if(sp?.id?.toLowerCase()!==principalId.toLowerCase()||sp.servicePrincipalType!=='ManagedIdentity'||sp.accountEnabled!==true||
        !Array.isArray(sp.alternativeNames)||!sp.alternativeNames.some(value=>String(value).toLowerCase()===identityResourceId.toLowerCase())||
        !Array.isArray(sp.keyCredentials)||!Array.isArray(sp.passwordCredentials))
        unresolved.push('service_principal_is_not_a_fully_resolved_managed_identity');
      // Microsoft Graph exposes a platform-managed X.509 verification key on
      // managed identities. It is not an application credential that the
      // workload owner can set: managed identity service principals cannot be
      // modified directly. Retain only safe certificate metadata, never key bytes.
      const platformCertificates=(sp?.keyCredentials??[]).filter(credential=>
        credential?.type==='AsymmetricX509Cert'&&credential?.usage==='Verify'&&
        String(credential?.displayName||'').toLowerCase()===`cn=${String(sp?.appId||'').toLowerCase()}`&&
        GUID.test(credential?.keyId||'')&&Number.isFinite(Date.parse(credential?.startDateTime))&&
        Number.isFinite(Date.parse(credential?.endDateTime))&&Date.parse(credential.endDateTime)>Date.parse(credential.startDateTime));
      const hasUnexpectedKeyCredentials=(sp?.keyCredentials?.length??0)!==platformCertificates.length;
      if(hasUnexpectedKeyCredentials||(sp?.passwordCredentials?.length??0)!==0)
        unresolved.push('service_principal_has_or_may_have_direct_credentials');
      snapshot.servicePrincipal={id:sp?.id??null,appId:sp?.appId??null,servicePrincipalType:sp?.servicePrincipalType??null,
        accountEnabled:sp?.accountEnabled??null,alternativeNames:Array.isArray(sp?.alternativeNames)?sp.alternativeNames:[],
        keyCredentialCount:Array.isArray(sp?.keyCredentials)?sp.keyCredentials.length:null,
        managedIdentityPlatformCertificateCount:platformCertificates.length,
        managedIdentityPlatformCertificateMetadata:platformCertificates.map(({keyId,type,usage,displayName,startDateTime,endDateTime})=>
          ({keyId,type,usage,displayName,startDateTime,endDateTime})),
        passwordCredentialCount:Array.isArray(sp?.passwordCredentials)?sp.passwordCredentials.length:null,
        federatedIdentityCredentialsApplicable:false};

      const [owners,groups,appRoles,grants]=await Promise.all([
        graphPages(`${GRAPH}/servicePrincipals/${encodeURIComponent(principalId)}/owners?$select=id`,token),
        graphPages(`${GRAPH}/servicePrincipals/${encodeURIComponent(principalId)}/transitiveMemberOf/microsoft.graph.group?$select=id`,token),
        graphPages(`${GRAPH}/servicePrincipals/${encodeURIComponent(principalId)}/appRoleAssignments?$select=id,appRoleId,resourceId,principalId`,token),
        graphPages(`${GRAPH}/oauth2PermissionGrants?$filter=clientId eq '${encodeURIComponent(principalId)}'&$select=id,clientId,resourceId,scope`,token)
      ]);
      for(const [label,items] of [['owner',owners],['group',groups],['application_role',appRoles],['delegated_permission',grants]])
        if(items.some(item=>!GUID.test(item?.id||''))) unresolved.push(`${label}_inventory_contains_malformed_object`);
      snapshot.owners=owners.map(item=>item.id).filter(value=>GUID.test(value||'')).sort();
      snapshot.transitiveGroups=groups.map(item=>item.id).filter(value=>GUID.test(value||'')).sort();
      snapshot.appRoleAssignments=appRoles.map(({id,appRoleId,resourceId,principalId:owner})=>({id,appRoleId,resourceId,principalId:owner}));
      snapshot.delegatedPermissionGrants=grants.map(({id,clientId:client,resourceId,scope})=>({id,clientId:client,resourceId,scope}));
      if(owners.length) unresolved.push('service_principal_has_credential_owners');
      if(groups.length) unresolved.push('service_principal_has_transitive_group_paths');
      if(appRoles.length) unresolved.push('service_principal_has_application_role_grants');
      if(grants.length) unresolved.push('service_principal_has_delegated_permission_grants');
    } catch(error) {
      unresolved.push(error instanceof Error?'graph_inventory_incomplete':'graph_inventory_failed');
    }

    if(typeof reviewAzureAttachPaths!=='function') unresolved.push('azure_identity_assignment_and_attach_paths_not_reviewed');
    else {
      try {
        const review=await reviewAzureAttachPaths({principalId:principalId.toLowerCase(),identityResourceId,runId,scenario,container,targetResourceId,
          observerPrincipalId:observerPrincipalId.toLowerCase()});
        snapshot.azureAttachPathReview=review;
        if(!review||review.status!=='complete'||review.readOnly!==true||review.observerPrincipalId?.toLowerCase()!==observerPrincipalId.toLowerCase()||
          review.principalId?.toLowerCase()!==principalId.toLowerCase()||review.identityResourceId?.toLowerCase()!==identityResourceId.toLowerCase()||
          review.allPathsResolved!==true||!Array.isArray(review.unresolvedPaths)||review.unresolvedPaths.length!==0||
          !REF.test(review.evidenceReference||'')||!/^sha256:[a-f0-9]{64}$/i.test(review.snapshotFingerprint||''))
          unresolved.push('azure_identity_assignment_and_attach_paths_incomplete');
      } catch {unresolved.push('azure_identity_assignment_and_attach_paths_failed');}
    }
    return persistResult(snapshot,result);

    async function persistResult(value,summary) {
      value.unresolvedPaths=[...new Set(unresolved)];
      const snapshotFingerprint=fingerprint(value);
      try {
        const saved=await persistSnapshot({snapshot:value,observerPrincipalId:observerPrincipalId.toLowerCase()});
        if(!saved||!REF.test(saved.reference||'')) throw new Error('protected reference missing');
        summary.evidenceReference=saved.reference;summary.snapshotFingerprint=snapshotFingerprint;
        summary.observedAt=value.observedAt;
      } catch {summary.unresolvedPaths.push('credential_path_snapshot_not_protected');}
      summary.unresolvedPaths=[...new Set(summary.unresolvedPaths)];
      summary.status=summary.unresolvedPaths.length===0?'complete':'incomplete';
      summary.allPathsResolved=summary.status==='complete';
      return summary;
    }
  };
}
