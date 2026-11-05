import test from 'node:test';
import assert from 'node:assert/strict';
import {createAciAzureLifecycleObserver,createFailClosedCredentialPathReviewer} from './aci-azure-lifecycle-observer.mjs';

const sub='11111111-1111-4111-8111-111111111111';
const workload='22222222-2222-4222-8222-222222222222';
const pull='33333333-3333-4333-8333-333333333333';
const groupId=`/subscriptions/${sub}/resourceGroups/rg/providers/Microsoft.ContainerInstance/containerGroups/run-u6-source`;
const workloadId=`/subscriptions/${sub}/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/workload`;
const pullId=`/subscriptions/${sub}/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/pull`;

test('independently observes current ACI group state and attached UAI principals read-only',async()=>{
  const calls=[];
  const observer=createAciAzureLifecycleObserver({subscriptionId:sub,resourceGroup:'rg',getManagementToken:async()=>'audit-token-123456789012',
    now:()=>Date.parse('2026-11-04T12:00:00Z'),fetchImpl:async(url,options)=>{
      calls.push({url,method:options.method});
      if(url.includes('containerGroups')) return new Response(JSON.stringify({id:groupId,systemData:{createdAt:'2026-11-04T11:59:00Z'},
        properties:{provisioningState:'Succeeded',instanceView:{state:'Running'}},identity:{userAssignedIdentities:{[workloadId]:{},[pullId]:{}}}}));
      if(url.includes('/workload?')) return new Response(JSON.stringify({properties:{principalId:workload}}));
      if(url.includes('/pull?')) return new Response(JSON.stringify({properties:{principalId:pull}}));
      return new Response('{}',{status:404});
    }});
  const result=await observer.observeGroup({group:{name:'run-u6-source',resourceId:groupId},identity:{objectId:workload}});
  assert.equal(result.state,'Running');assert.equal(result.identityObjectId,workload);
  assert.deepEqual(result.attachedPrincipalObjectIds.sort(),[pull,workload].sort());
  assert.ok(calls.every(x=>x.method==='GET'));
});

test('Activity Log snapshot reports unsupported historical attachment/deletion claims as incomplete',async()=>{
  const observer=createAciAzureLifecycleObserver({subscriptionId:sub,resourceGroup:'rg',getManagementToken:async()=>'audit-token-123456789012',
    now:()=>Date.parse('2026-11-04T12:00:00Z'),fetchImpl:async(url,options)=>{
      assert.equal(options.method,'GET');
      assert.match(url,/Microsoft.Insights|eventtypes\/management/);
      return new Response(JSON.stringify({value:[{resourceId:groupId,operationName:{value:'Microsoft.ContainerInstance/containerGroups/write'},
        status:{value:'Succeeded'},eventTimestamp:'2026-11-04T11:00:00Z'}]}));
    }});
  const result=await observer.readAciLifecycleEvidence({runId:'r4-b01-01-aci-P2-U6',scenario:'U6',observerPrincipalId:'44444444-4444-4444-8444-444444444444',
    evidence:{events:[{at:'2026-11-04T11:00:00Z'}],observations:{probeRead:{startedAt:'2026-11-04T11:01:00Z'}}}});
  assert.equal(result.source,'azure_aci_arm_activity_snapshot_v1');
  assert.equal(result.snapshot.completeness.groupAttachmentHistory,false);
  assert.equal(result.snapshot.completeness.identityDeletionAndGrantRemoval,false);
  assert.deepEqual(result.snapshot.groups,[]);assert.equal(result.snapshot.activityLogEvents.length,1);
});

test('credential path reviewer fails closed with named unresolved proof requirement',async()=>{
  const result=await createFailClosedCredentialPathReviewer()({});
  assert.equal(result.status,'incomplete');assert.equal(result.allPathsResolved,false);
  assert.match(result.unresolvedPaths[0],/group_membership_and_indirect_credential_path_proof_not_configured/);
});
