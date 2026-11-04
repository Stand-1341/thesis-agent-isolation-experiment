import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {attachAciIdentityPrincipalIds,buildAciRunIdentityManifest,buildAciRunIdentitySpecs,createAciPreprovisionedIdentityProvider,aciRunIdentityName} from './aci-preprovisioned-identity-provider.mjs';

const sub='11111111-1111-4111-8111-111111111111',tenant='22222222-2222-4222-8222-222222222222';
const controller='33333333-3333-4333-8333-333333333333',principal='44444444-4444-4444-8444-444444444444';
const client='55555555-5555-4555-8555-555555555555';
const runId='pilot-aci-u6-p1-U6',role='source',container='session-b';
const name=aciRunIdentityName(runId,'U6',role);
const identityId=`/subscriptions/${sub}/resourceGroups/rg-pilot/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${name}`;
const target=`/subscriptions/${sub}/resourceGroups/rg-pilot/providers/Microsoft.Storage/storageAccounts/store123/blobServices/default/containers/${container}`;
const assignmentId=`${target}/providers/Microsoft.Authorization/roleAssignments/66666666-6666-4666-8666-666666666666`;
const now=()=>Date.parse('2026-11-04T12:00:00Z');

function harness({includeIdentity=true,complete=true}={}) {
  const identityInventory=[{name,principalId:principal},...Array.from({length:29},(_,i)=>({name:`unused-${i}`,principalId:`70000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`}))];
  const calls=[],alive=new Set(includeIdentity?[identityId.toLowerCase()]:[]),raAlive=new Set([assignmentId.toLowerCase()]);
  const fetchImpl=async(url,options)=>{
    calls.push({url,method:options.method});const parsed=new URL(url),path=parsed.pathname;
    if(path.endsWith('/roleAssignments')) return new Response(JSON.stringify({value:[
      {id:`${identityId}/providers/Microsoft.Authorization/roleAssignments/77777777-7777-4777-8777-777777777777`,properties:{principalId:controller,roleDefinitionId:'/subscriptions/11111111-1111-4111-8111-111111111111/providers/Microsoft.Authorization/roleDefinitions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}},
      {id:`${identityId}/providers/Microsoft.Authorization/roleAssignments/88888888-8888-4888-8888-888888888888`,properties:{principalId:controller,roleDefinitionId:'/subscriptions/11111111-1111-4111-8111-111111111111/providers/Microsoft.Authorization/roleDefinitions/f58310d9-a9f6-439a-9e8d-f62e7b41a168'}}]}),{status:200});
    if(path.includes('/userAssignedIdentities/')) {
      const key=path.toLowerCase();
      if(options.method==='DELETE'){alive.delete(key);return new Response(null,{status:202});}
      return alive.has(key)?new Response(JSON.stringify({id:identityId,location:'eastus',systemData:{createdAt:'2026-11-04T11:59:00Z'},properties:{tenantId:tenant,principalId:principal,clientId:client,provisioningState:'Succeeded'}}),{status:200}):new Response('{}',{status:404});
    }
    if(path.includes('/roleAssignments/')) {
      const key=path.toLowerCase();if(options.method==='DELETE'){raAlive.delete(key);return new Response(null,{status:204});}
      return raAlive.has(key)?new Response(JSON.stringify({id:assignmentId}),{status:200}):new Response('{}',{status:404});
    }
    return new Response('{}',{status:404});
  };
  const observer=async args=>({runId:args.runId,principalId:args.principalId,status:complete?'complete':'partial',complete,includesInherited:complete,
    groupMembershipsResolved:complete,groupPrincipalIds:[],customRolesResolved:complete,dataActionsResolved:complete,indirectCredentialPathsResolved:complete,
    unknownRoleDefinitions:[],httpStatus:200,readOnly:true,readMethod:'azure_role_assignments_effective_snapshot',
    observerPrincipalId:'66666666-6666-4666-8666-666666666666',evidenceReference:'https://evidence.example.test/rbac/u6',
    snapshotFingerprint:`sha256:${'a'.repeat(64)}`,observedAt:'2026-11-04T12:00:00Z',effectiveRoleAssignments:[
      {assignmentId,scope:target,principalId:args.principalId,roleDefinitionId:'ba92f5b4-2d11-453d-a403-e96b0029c9fe'}]});
  const provider=createAciPreprovisionedIdentityProvider({subscriptionId:sub,resourceGroup:'rg-pilot',tenantId:tenant,location:'eastus',
    controllerPrincipalId:controller,identityLifecycleRoleDefinitionId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',identityInventory,
    getManagementToken:async()=>'test-token',observeEffectiveAssignments:observer,fetchImpl,now,sleep:async()=>{}});
  return {provider,calls,alive,raAlive};
}

test('manifest is derived from exact frozen bytes and fails on digest mismatch',()=>{
  const csv=Buffer.from('planned_run_id,scenario_id\npilot-aci-u6-p1-U6,U6\npilot-aci-l2,L2\npilot-aci-u8-p2-U8,U8\n');
  const sha=createHash('sha256').update(csv).digest('hex');
  const manifest=buildAciRunIdentityManifest(csv,sha);
  assert.equal(manifest.scheduleSha256,sha);assert.equal(manifest.identitySpecs.length,6);
  assert.deepEqual(manifest.identitySpecs.slice(0,3).map(x=>x.role),['source','probe','cleanup']);
  assert.equal(manifest.identitySpecs.at(-1).container,'prior-session');
  assert.throws(()=>buildAciRunIdentityManifest(csv,'0'.repeat(64)),/digest mismatch/);
  const ids=manifest.identitySpecs.map((spec,i)=>({name:spec.name,principalId:`70000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`}));
  assert.equal(attachAciIdentityPrincipalIds(manifest,ids).identitySpecs[0].principalId,ids[0].principalId);
  assert.throws(()=>attachAciIdentityPrincipalIds(manifest,ids.slice(1)),/does not exactly match/);
});

test('spec generator rejects replayed IDs, invalid scenario, and duplicate deterministic names',()=>{
  const specs=buildAciRunIdentitySpecs([{runId,scenario:'U6'}]);assert.equal(specs.length,3);
  assert.throws(()=>buildAciRunIdentitySpecs([{runId,scenario:'U6'},{runId,scenario:'U6'}]),/duplicate/);
  assert.throws(()=>aciRunIdentityName('wrong','U6','source'),/invalid/);
});

test('claims pre-provisioned identity read-only, returns independently validated analog shape, then removes exact grants and identity',async()=>{
  const {provider,calls,alive}=harness();
  const identity=await provider.createIdentity({runId,scenario:'U6',role,container,target:{resourceId:target}});
  assert.equal(identity.objectId,principal);assert.equal(identity.created,true);assert.equal(identity.accessReview.complete,true);
  assert.equal(identity.accessReview.effectiveRoleAssignments.length,1);
  assert.ok(calls.every(x=>x.method==='GET'),'claiming never creates or updates Azure resources');
  await assert.rejects(provider.createIdentity({runId,scenario:'U6',role,container,target:{resourceId:target}}),/already claimed/);
  const deleted=await provider.deleteIdentity({identity});assert.equal(deleted.deleted,true);assert.equal(alive.size,0);
  assert.ok(calls.some(x=>x.method==='DELETE'&&x.url.toLowerCase().includes('roleassignments/')));
  assert.ok(calls.some(x=>x.method==='DELETE'&&x.url.toLowerCase().includes('userassignedidentities/')));
});

test('missing UAI and incomplete independent snapshot fail closed',async()=>{
  const missing=harness({includeIdentity:false});
  await assert.rejects(missing.provider.createIdentity({runId,scenario:'U6',role,container,target:{resourceId:target}}),/not preprovisioned/);
  const partial=harness({complete:false});
  await assert.rejects(partial.provider.createIdentity({runId,scenario:'U6',role,container,target:{resourceId:target}}),/snapshot is incomplete/);
});
