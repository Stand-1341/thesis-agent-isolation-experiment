import test from 'node:test';
import assert from 'node:assert/strict';
import {readEvidenceRetentionStatus,resolveEvidenceContainerScope} from './evidence-retention.mjs';

const accountId='/subscriptions/11111111-2222-4333-8444-555555555555/resourceGroups/evidence-rg/providers/Microsoft.Storage/storageAccounts/thesisstore123';
const containerUrl='https://thesisstore123.blob.core.windows.net/evidence';
const subscriptionId='11111111-2222-4333-8444-555555555555';
const policyResourceId=`${accountId}/blobServices/default/containers/evidence/immutabilityPolicies/default`;
function policy({state='Locked',days=7,id=policyResourceId}={}) {
  return {id,name:'default',type:'Microsoft.Storage/storageAccounts/blobServices/containers/immutabilityPolicies',
    properties:{state,immutabilityPeriodSinceCreationInDays:days}};
}

test('evidence policy lookup binds a read-only ARM GET to the exact resolved container',async()=>{
  let args;
  const result=await readEvidenceRetentionStatus({az:async value=>{args=value;return policy();},accountId,containerUrl,subscriptionId,requiredDays:7});
  assert.deepEqual(result,{state:'locked',locked:true,periodDays:7,policyResourceId});
  assert.deepEqual(args.slice(0,2),['rest','--method']);
  assert.equal(args[args.indexOf('--method')+1],'get');
  assert.ok(args.includes('--method') && args.includes('get'));
  assert.match(args[args.indexOf('--url')+1],/containers\/evidence\/immutabilityPolicies\/default\?api-version=2025-08-01$/);
  assert.ok(args.includes('--subscription') && args.includes(subscriptionId));
  assert.doesNotMatch(args.join(' '),/put|patch|delete/i);
});

test('unlocked, short-period, and absent container policies fail closed',async()=>{
  assert.equal((await readEvidenceRetentionStatus({az:async()=>policy({state:'Unlocked'}),accountId,containerUrl,subscriptionId})).locked,false);
  const short=await readEvidenceRetentionStatus({az:async()=>policy({days:6}),accountId,containerUrl,subscriptionId,requiredDays:7});
  assert.equal(short.state,'locked');
  assert.equal(short.locked,false);
  const missing=await readEvidenceRetentionStatus({az:async()=>{const error=new Error('ResourceNotFound');error.code=404;throw error;},accountId,containerUrl,subscriptionId});
  assert.deepEqual(missing,{state:'unlocked',locked:false,reason:'container immutability policy was not found',policyResourceId});
});

test('mismatched IDs, unsupported endpoint shapes, and ARM errors are unknown and fail closed',async()=>{
  const mismatch=await readEvidenceRetentionStatus({az:async()=>policy({id:'/subscriptions/other/resourceGroups/elsewhere/providers/Microsoft.Storage/storageAccounts/other/blobServices/default/containers/elsewhere/immutabilityPolicies/default'}),accountId,containerUrl,subscriptionId});
  assert.equal(mismatch.state,'unknown');
  assert.equal(mismatch.locked,false);
  assert.equal((await readEvidenceRetentionStatus({az:async()=>policy(),accountId,containerUrl:'https://other.blob.core.windows.net/evidence',subscriptionId})).state,'unknown');
  assert.equal((await readEvidenceRetentionStatus({az:async()=>{throw new Error('authorization denied');},accountId,containerUrl,subscriptionId})).state,'unknown');
  assert.equal(resolveEvidenceContainerScope({accountId,containerUrl,subscriptionId}).policyResourceId,policyResourceId);
});
