import test from 'node:test';
import assert from 'node:assert/strict';
import {createAzureManagedIdentityCredentialPathReviewer} from './azure-managed-identity-credential-path-reviewer.mjs';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const principalId=id(1),observerPrincipalId=id(2),clientId=id(3),runId='r4-b01-01-aci-P2-U6';
const identityResourceId=`/subscriptions/${id(4)}/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/uai-source`;
const targetResourceId=`/subscriptions/${id(4)}/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/store123/blobServices/default/containers/session-b`;

function reviewer({credentials=[],owners=[],groups=[],appRoles=[],grants=[],attachReview=true}={}) {
  const snapshots=[];
  const fetchImpl=async url=>{
    const parsed=new URL(url);
    if(parsed.pathname.endsWith(`/servicePrincipals/${principalId}`)) return new Response(JSON.stringify({id:principalId,appId:clientId,
      servicePrincipalType:'ManagedIdentity',accountEnabled:true,alternativeNames:[identityResourceId],keyCredentials:[{keyId:id(23),
        type:'AsymmetricX509Cert',usage:'Verify',displayName:`CN=${clientId}`,startDateTime:'2026-11-04T08:55:00Z',endDateTime:'2027-02-02T08:55:00Z'}],
      passwordCredentials:credentials}),{status:200});
    if(parsed.pathname.endsWith('/owners')) return new Response(JSON.stringify({value:owners.map(id=>({id}))}));
    if(parsed.pathname.endsWith('/transitiveMemberOf/microsoft.graph.group')) return new Response(JSON.stringify({value:groups.map(id=>({'@odata.type':'#microsoft.graph.group',id}))}));
    if(parsed.pathname.endsWith('/appRoleAssignments')) return new Response(JSON.stringify({value:appRoles.map(id=>({id,appRoleId:id,resourceId:id,principalId}))}));
    if(parsed.pathname.endsWith('/oauth2PermissionGrants')) return new Response(JSON.stringify({value:grants.map(id=>({id,clientId:principalId,resourceId:id,scope:'read'}))}));
    return new Response('{}',{status:404});
  };
  const value=createAzureManagedIdentityCredentialPathReviewer({getGraphToken:async()=>'graph-token-12345678901234567890',
    observerPrincipalId,persistSnapshot:async item=>{snapshots.push(item);return {reference:'urn:credential-review:versioned'};},
    ...(attachReview?{reviewAzureAttachPaths:async()=>({status:'complete',readOnly:true,observerPrincipalId,principalId,
      identityResourceId,allPathsResolved:true,unresolvedPaths:[],evidenceReference:'urn:attach-review:1',snapshotFingerprint:`sha256:${'a'.repeat(64)}`})}:{}),
    fetchImpl,now:()=>Date.parse('2026-11-05T12:00:00Z')});
  return {value,snapshots};
}

const args={principalId,identityResourceId,runId,scenario:'U6',container:'session-b',targetResourceId};

test('returns complete only when Graph inventories and Azure attach-path review are complete',async()=>{
  const {value,snapshots}=reviewer();
  const result=await value(args);
  assert.equal(result.status,'complete');assert.equal(result.allPathsResolved,true);
  assert.deepEqual(result.unresolvedPaths,[]);assert.equal(result.observerPrincipalId,observerPrincipalId);
  assert.equal(result.evidenceReference,'urn:credential-review:versioned');
  assert.match(result.snapshotFingerprint,/^sha256:[a-f0-9]{64}$/);
  assert.equal(snapshots[0].snapshot.schema,'azure_identity_credential_path_review_v1');
});

test('fails closed when Azure identity attachment-path review is absent',async()=>{
  const result=await reviewer({attachReview:false}).value(args);
  assert.equal(result.status,'incomplete');assert.equal(result.allPathsResolved,false);
  assert.ok(result.unresolvedPaths.includes('azure_identity_assignment_and_attach_paths_not_reviewed'));
});

test('fails closed when a managed identity has credentials, owners, or group paths',async()=>{
  const result=await reviewer({credentials:[{keyId:id(20)}],owners:[id(21)],groups:[id(22)]}).value(args);
  assert.equal(result.status,'incomplete');
  assert.ok(result.unresolvedPaths.includes('service_principal_has_or_may_have_direct_credentials'));
  assert.ok(result.unresolvedPaths.includes('service_principal_has_credential_owners'));
  assert.ok(result.unresolvedPaths.includes('service_principal_has_transitive_group_paths'));
});

test('treats only the Azure managed identity platform verification certificate as non-configurable metadata',async()=>{
  const {value,snapshots}=reviewer();
  const result=await value(args);
  assert.equal(result.status,'complete');
  assert.equal(snapshots[0].snapshot.servicePrincipal.managedIdentityPlatformCertificateCount,1);
  assert.equal('key' in snapshots[0].snapshot.servicePrincipal.managedIdentityPlatformCertificateMetadata[0],false);
});

test('requires exact managed identity and scope binding',async()=>{
  const {value}=reviewer();
  const result=await value({...args,identityResourceId:`/subscriptions/${id(4)}/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/uai-other`});
  assert.equal(result.status,'incomplete');
  assert.ok(result.unresolvedPaths.includes('service_principal_is_not_a_fully_resolved_managed_identity'));
});
