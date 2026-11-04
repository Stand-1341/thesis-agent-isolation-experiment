import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAciRunScopedIdentityProvider,ACI_BLOB_DATA_CONTRIBUTOR_ROLE_ID} from './aci-run-scoped-identity-provider.mjs';

const sub='11111111-1111-4111-8111-111111111111';
const tenant='22222222-2222-4222-8222-222222222222';
const observer='33333333-3333-4333-8333-333333333333';
const target='/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/rg-pilot/providers/Microsoft.Storage/storageAccounts/store123/blobServices/default/containers/session-b';
const now=()=>Date.parse('2026-11-04T12:00:00Z');

function harness({snapshotOverride}={}) {
  const identities=new Map(),assignments=new Map(),calls=[];
  const urlForIdentity=name=>`https://management.azure.com/subscriptions/${sub}/resourceGroups/rg-pilot/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${name}?api-version=2023-01-31`;
  const fetchImpl=async(url,options)=>{
    calls.push({url,method:options.method,body:options.body?JSON.parse(options.body):undefined});
    const parsed=new URL(url),path=parsed.pathname;
    const identityMatch=path.match(/userAssignedIdentities\/([^/]+)$/i);
    const roleMatch=path.match(/roleAssignments\/([^/]+)$/i);
    if(identityMatch) {
      const name=decodeURIComponent(identityMatch[1]);
      if(options.method==='PUT') {
        const n=identities.size+1;
        const resource={id:`/subscriptions/${sub}/resourceGroups/rg-pilot/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${name}`,
          name,location:'eastus',systemData:{createdAt:'2026-11-04T11:59:00Z'},properties:{provisioningState:'Succeeded',
            principalId:`40000000-0000-4000-8000-${String(n).padStart(12,'0')}`,
            clientId:`50000000-0000-4000-8000-${String(n).padStart(12,'0')}`,tenantId:tenant}};
        identities.set(name,resource);return new Response(JSON.stringify(resource),{status:202});
      }
      if(options.method==='GET') return identities.has(name)?new Response(JSON.stringify(identities.get(name)),{status:200}):new Response('{}',{status:404});
      if(options.method==='DELETE') {identities.delete(name);return new Response(null,{status:202});}
    }
    if(roleMatch) {
      const id=decodeURIComponent(roleMatch[1]);
      const roleUrl=path.slice(0,path.lastIndexOf('/providers/Microsoft.Authorization/roleAssignments/'));
      const key=`${roleUrl.toLowerCase()}/${id.toLowerCase()}`;
      if(options.method==='PUT') {
        const body=JSON.parse(options.body);
        const role={id:`${roleUrl}/providers/Microsoft.Authorization/roleAssignments/${id}`,
          properties:{...body.properties,scope:roleUrl}};
        assignments.set(key,role);return new Response(JSON.stringify(role),{status:201});
      }
      if(options.method==='GET') return assignments.has(key)?new Response(JSON.stringify(assignments.get(key)),{status:200}):new Response('{}',{status:404});
      if(options.method==='DELETE') {assignments.delete(key);return new Response(null,{status:204});}
    }
    return new Response(JSON.stringify({error:{code:'UnexpectedRequest'}}),{status:500});
  };
  const observeEffectiveAssignments=async args=>{
    if(snapshotOverride) return snapshotOverride(args,assignments);
    const effectiveRoleAssignments=[...assignments.values()].filter(item=>item.properties.principalId===args.principalId)
      .map(item=>({assignmentId:item.id,roleDefinitionId:item.properties.roleDefinitionId,scope:item.properties.scope,principalId:item.properties.principalId}));
    return {runId:args.runId,principalId:args.principalId,status:'complete',complete:true,includesInherited:true,
      groupMembershipsResolved:true,groupPrincipalIds:[],customRolesResolved:true,dataActionsResolved:true,
      indirectCredentialPathsResolved:true,unknownRoleDefinitions:[],httpStatus:200,readOnly:true,
      readMethod:'azure_role_assignments_effective_snapshot',observerPrincipalId:observer,
      evidenceReference:`https://evidence.example.test/rbac/${args.role}`,snapshotFingerprint:`sha256:${'a'.repeat(64)}`,
      observedAt:'2026-11-04T12:00:00Z',effectiveRoleAssignments};
  };
  const provider=createAciRunScopedIdentityProvider({subscriptionId:sub,resourceGroup:'rg-pilot',location:'eastus',tenantId:tenant,
    getManagementToken:async()=>'arm-token',observeEffectiveAssignments,fetchImpl,now,sleep:async()=>{}});
  return {provider,identities,assignments,calls,urlForIdentity};
}

test('creates source identity with a single container-scoped Blob Data Contributor and independent ARM access evidence',async()=>{
  const {provider,identities,assignments,calls}=harness();
  const result=await provider.createIdentity({runId:'pilot-aci-u6-01',scenario:'U6',role:'source',container:'session-b',target:{resourceId:target}});
  assert.equal(result.created,true);
  assert.match(result.resourceId,/userAssignedIdentities\/aci-[a-f0-9]{32}-source$/);
  assert.equal(result.accessReview.complete,true);
  assert.equal(result.accessReview.includesInherited,true);
  assert.equal(result.accessReview.readMethod,'azure_role_assignments_effective_snapshot');
  assert.equal(result.accessReview.effectiveRoleAssignments.length,1);
  assert.equal(result.accessReview.effectiveRoleAssignments[0].roleDefinitionId,ACI_BLOB_DATA_CONTRIBUTOR_ROLE_ID);
  assert.equal(result.accessReview.effectiveRoleAssignments[0].scope,target);
  assert.equal(identities.size,1);assert.equal(assignments.size,1);
  const body=calls.find(call=>call.method==='PUT'&&call.url.includes('roleAssignments'))?.body;
  assert.equal(body.properties.principalId,result.objectId);
  assert.equal(body.properties.principalType,'ServicePrincipal');
  assert.equal(body.properties.roleDefinitionId,`/subscriptions/${sub}/providers/Microsoft.Authorization/roleDefinitions/${ACI_BLOB_DATA_CONTRIBUTOR_ROLE_ID}`);
});

test('probe identity receives no direct Blob role and refuses an unobserved inherited/group-complete snapshot',async()=>{
  const {provider,assignments}=harness();
  const probe=await provider.createIdentity({runId:'pilot-aci-u8-01',scenario:'U8',role:'probe',container:'prior-session',
    target:{resourceId:target.replace('session-b','prior-session')}});
  assert.equal(assignments.size,0);
  assert.equal(probe.accessReview.effectiveRoleAssignments.length,0);

  const bad=harness({snapshotOverride:async args=>({runId:args.runId,principalId:args.principalId,status:'complete',complete:true,
    includesInherited:false,groupMembershipsResolved:false,groupPrincipalIds:[],customRolesResolved:true,dataActionsResolved:true,
    indirectCredentialPathsResolved:true,unknownRoleDefinitions:[],httpStatus:200,readOnly:true,
    readMethod:'azure_role_assignments_effective_snapshot',observerPrincipalId:observer,
    evidenceReference:'https://evidence.example.test/incomplete',snapshotFingerprint:`sha256:${'b'.repeat(64)}`,
    observedAt:'2026-11-04T12:00:00Z',effectiveRoleAssignments:[]})});
  await assert.rejects(bad.provider.createIdentity({runId:'pilot-aci-u8-02',scenario:'U8',role:'source',container:'session-b',
    target:{resourceId:target}}),/snapshot is incomplete/);
  assert.equal(bad.identities.size,0,'identity is rolled back if independent evidence is incomplete');
  assert.equal(bad.assignments.size,0,'exact-scope role assignment is rolled back with the identity');
});

test('cleanup deletes only tracked scoped assignment and identity, then confirms absence',async()=>{
  const {provider,identities,assignments}=harness();
  const identity=await provider.createIdentity({runId:'pilot-aci-u6-cleanup',scenario:'U6',role:'cleanup',container:'session-b',target:{resourceId:target}});
  const deleted=await provider.deleteIdentity({identity});
  assert.deepEqual(deleted,{deleted:true,objectId:identity.objectId,roleAssignmentsRemoved:true,deletedAt:'2026-11-04T12:00:00.000Z'});
  assert.equal(identities.size,0);assert.equal(assignments.size,0);
  await assert.rejects(provider.deleteIdentity({identity}),/not created by this provider/);
});

test('rejects probe snapshots with an inherited or existing Blob reader/owner assignment',async()=>{
  const inherited=harness({snapshotOverride:async args=>({runId:args.runId,principalId:args.principalId,status:'complete',complete:true,
    includesInherited:true,groupMembershipsResolved:true,groupPrincipalIds:[],customRolesResolved:true,dataActionsResolved:true,
    indirectCredentialPathsResolved:true,unknownRoleDefinitions:[],httpStatus:200,readOnly:true,
    readMethod:'azure_role_assignments_effective_snapshot',observerPrincipalId:observer,
    evidenceReference:'https://evidence.example.test/rbac/inherited',snapshotFingerprint:`sha256:${'c'.repeat(64)}`,
    observedAt:'2026-11-04T12:00:00Z',effectiveRoleAssignments:[{assignmentId:`${target}/providers/Microsoft.Authorization/roleAssignments/66666666-6666-4666-8666-666666666666`,
      roleDefinitionId:'b7e6dc6d-f1e8-4753-8033-0f276bb0955b',scope:target,principalId:args.principalId}]})});
  await assert.rejects(inherited.provider.createIdentity({runId:'pilot-aci-u6-overgrant',scenario:'U6',role:'probe',container:'session-b',
    target:{resourceId:target}}),/probe identity unexpectedly has a Blob read or write assignment/);
  assert.equal(inherited.identities.size,0);
});

test('refuses out-of-scope containers before making ARM requests and rejects deterministic replay',async()=>{
  const {provider,calls}=harness();
  await assert.rejects(provider.createIdentity({runId:'pilot-aci-u6-bad',scenario:'U6',role:'source',container:'session-b',
    target:{resourceId:target.replace('rg-pilot','other-rg')}}),/configured subscription\/resource group/);
  assert.equal(calls.length,0);
  const args={runId:'pilot-aci-u6-repeat',scenario:'U6',role:'probe',container:'session-b',target:{resourceId:target}};
  await provider.createIdentity(args);
  await assert.rejects(provider.createIdentity(args),/already exists; refusing replay/);
});
