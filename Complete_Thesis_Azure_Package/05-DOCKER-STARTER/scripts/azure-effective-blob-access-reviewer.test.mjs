import test from 'node:test';
import assert from 'node:assert/strict';
import {createAzureEffectiveBlobAccessReviewer} from './azure-effective-blob-access-reviewer.mjs';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const principalId=id(1),observerPrincipalId=id(2),groupId=id(3),roleId='ba92f5b4-2d11-453d-a403-e96b0029c9fe';
const runId='pilot-aci-p1-u6-r1',scenario='U6',container='session-b';
const targetResourceId=`/subscriptions/${id(10)}/resourceGroups/rg-test/providers/Microsoft.Storage/storageAccounts/teststorage/blobServices/default/containers/${container}`;
const blobRead='Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read';
const blobWrite='Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write';
const containerActions=['Microsoft.Storage/storageAccounts/blobServices/containers/read','Microsoft.Storage/storageAccounts/blobServices/containers/write',
  'Microsoft.Storage/storageAccounts/blobServices/containers/delete','Microsoft.Storage/storageAccounts/blobServices/generateUserDelegationKey/action'];
const contributor={id:`/subscriptions/${id(10)}/providers/Microsoft.Authorization/roleDefinitions/${roleId}`,
  properties:{roleName:'Storage Blob Data Contributor',permissions:[{actions:containerActions,notActions:[],dataActions:[blobRead,blobWrite,
    'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/delete','Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action',
    'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/move/action'],notDataActions:[]}]}};
const assignment=(who=principalId,scope=targetResourceId,extra={})=>({id:`${scope}/providers/Microsoft.Authorization/roleAssignments/${id(4)}`,
  properties:{principalId:who,principalType:who===groupId?'Group':'ServicePrincipal',roleDefinitionId:contributor.id,scope,...extra}});
const deny=(extra={})=>({id:`${targetResourceId}/providers/Microsoft.Authorization/denyAssignments/${id(5)}`,
  properties:{scope:targetResourceId,principals:[{id:principalId,type:'ServicePrincipal'}],excludePrincipals:[],doNotApplyToChildScopes:false,
    permissions:[{dataActions:[blobRead],notDataActions:[]}],...extra}});
function makeReviewer({assignments=[assignment()],groups=[],denies=[],definition=contributor,failGraph=false,failDefinition=false,
  graphNextLink,failCredentialReview=false,persist=async()=>({reference:'urn:rbac-snapshot:test-1'}),extraFetch}={}) {
  const requests=[],saved=[];
  const fetchImpl=async(url,options)=>{
    requests.push({url,method:options.method});
    if(url.includes('graph.microsoft.com')) return failGraph?new Response('{}',{status:403}):new Response(JSON.stringify({value:groups,...(graphNextLink?{'@odata.nextLink':graphNextLink}:{})}),{status:200});
    if(url.includes('/roleAssignments?')) return new Response(JSON.stringify({value:assignments}),{status:200});
    if(url.includes('/denyAssignments?')) return new Response(JSON.stringify({value:denies}),{status:200});
    if(url.includes('/roleDefinitions/')) return failDefinition?new Response('{}',{status:403}):new Response(JSON.stringify(definition),{status:200});
    return extraFetch?extraFetch(url,options):new Response('{}',{status:404});
  };
  const reviewer=createAzureEffectiveBlobAccessReviewer({getManagementToken:async()=>`management-token-${'x'.repeat(24)}`,
    getGraphToken:async()=>`graph-token-${'x'.repeat(24)}`,observerPrincipalId,
    reviewCredentialPaths:async({principalId,runId,container,targetResourceId,observerPrincipalId})=>({status:failCredentialReview?'incomplete':'complete',
      source:'azure_live_identity_credential_path_review_v1',principalId,runId,container,resourceId:targetResourceId,observerPrincipalId,readOnly:true,
      allPathsResolved:!failCredentialReview,unresolvedPaths:failCredentialReview?['unreadable credential source']:[],
      evidenceReference:'urn:credential-review:test-1',snapshotFingerprint:`sha256:${'c'.repeat(64)}`,observedAt:'2026-11-04T12:00:00.000Z'}),
    persistSnapshot:async value=>{saved.push(value);return persist(value);},fetchImpl,
    now:()=>Date.parse('2026-11-04T12:00:00.000Z')});
  return {reviewer,requests,saved};
}

test('returns complete, independently evidenced direct Blob access and strict source role review',async()=>{
  const {reviewer,saved,requests}=makeReviewer();
  const effective=await reviewer.evaluateEffectiveAccess({identity:{objectId:principalId},runId,scenario,container,targetResourceId});
  assert.equal(effective.status,'complete');
  assert.equal(effective.hasBlobRead,true);assert.equal(effective.hasBlobWrite,true);
  assert.equal(effective.inheritanceResolved,true);assert.equal(effective.groupMembershipsResolved,true);
  assert.equal(effective.customRolesResolved,true);assert.equal(effective.dataActionsResolved,true);
  assert.equal(effective.indirectCredentialPathsResolved,true);
  assert.equal(effective.effectiveAssignments.length,1);
  assert.match(effective.snapshotFingerprint,/^sha256:[a-f0-9]{64}$/);
  assert.equal(saved.length,1);
  assert.ok(requests.some(item=>item.url.includes('transitiveMemberOf')));
  assert.ok(requests.some(item=>item.url.includes('roleAssignments')));
  assert.ok(requests.some(item=>item.url.includes('denyAssignments')));
  const accessReview=await reviewer.reviewIdentityAccess({identity:{objectId:principalId},runId,scenario,container,targetResourceId});
  assert.equal(accessReview.status,'complete');assert.equal(accessReview.complete,true);assert.equal(accessReview.includesInherited,true);
  assert.equal(accessReview.groupMembershipsResolved,true);assert.deepEqual(accessReview.groupPrincipalIds,[]);
  assert.deepEqual(accessReview.unknownRoleDefinitions,[]);
  assert.equal(accessReview.effectiveRoleAssignments[0].principalId,principalId);
});

test('fails closed if transitive group assignment would be required to explain access',async()=>{
  const {reviewer,saved}=makeReviewer({groups:[{'@odata.type':'#microsoft.graph.group',id:groupId}],assignments:[assignment(groupId)]});
  await assert.rejects(reviewer.evaluateEffectiveAccess({identity:{objectId:principalId},runId,scenario,container,targetResourceId}),error=>{
    assert.equal(error.partialEvidence.status,'incomplete');
    assert.match(error.partialEvidence.unresolved.join(' '),/group-based role access/);
    return true;
  });
  assert.equal(saved.length,1);
});

test('fails closed when Graph membership, role definition, or protected evidence is unavailable',async()=>{
  for(const options of [{failGraph:true},{failDefinition:true},{persist:async()=>({})},{failCredentialReview:true}]) {
    const {reviewer}=makeReviewer(options);
    await assert.rejects(reviewer.evaluateEffectiveAccess({identity:{objectId:principalId},runId,scenario,container,targetResourceId}),error=>{
      assert.equal(error.partialEvidence.status,'incomplete');return true;
    });
  }
});

test('fails closed on conditional assignments, indirect credential permissions, and unknown parent scope',async()=>{
  const cases=[
    {assignments:[assignment(principalId,targetResourceId,{condition:'@Resource[Microsoft.Storage/storageAccounts/blobServices/containers:name] StringEquals "x"'})]},
    {definition:{...contributor,properties:{...contributor.properties,permissions:[{actions:['Microsoft.Storage/storageAccounts/listKeys/action'],notActions:[],dataActions:[],notDataActions:[]}]}}},
    {assignments:[assignment(principalId,`/providers/Microsoft.Management/managementGroups/${id(30)}`)]}
  ];
  for(const options of cases) {
    const {reviewer}=makeReviewer(options);
    await assert.rejects(reviewer.evaluateEffectiveAccess({identity:{objectId:principalId},runId,scenario,container,targetResourceId}),error=>{
      assert.equal(error.partialEvidence.status,'incomplete');return true;
    });
  }
});

test('applies an effective deny assignment instead of reporting Blob read access',async()=>{
  const {reviewer}=makeReviewer({denies:[deny()]});
  const effective=await reviewer.evaluateEffectiveAccess({identity:{objectId:principalId},runId,scenario,container,targetResourceId});
  assert.equal(effective.status,'complete');
  assert.equal(effective.hasBlobRead,false);
  assert.equal(effective.hasBlobWrite,true);
});

test('refuses untrusted pagination and malformed principal/target input',async()=>{
  const {reviewer}=makeReviewer({extraFetch:async()=>new Response('{}',{status:404})});
  await assert.rejects(reviewer.evaluateEffectiveAccess({identity:{objectId:'not-guid'},runId,container,targetResourceId}),/invalid Azure Blob/);
  const malicious=makeReviewer({graphNextLink:'https://evil.example/steal'});
  await assert.rejects(malicious.reviewer.evaluateEffectiveAccess({identity:{objectId:principalId},runId,scenario,container,targetResourceId}),error=>{
    assert.equal(error.partialEvidence.status,'incomplete');return true;
  });
});


