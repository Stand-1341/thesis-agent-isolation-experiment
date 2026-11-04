import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertLockedEvidencePolicy,createMeasuredEvidenceStoreFromEnvironment} from './azure-measured-evidence-store.mjs';

const env={
  THESIS_EVIDENCE_RETENTION_APPROVED:'true',
  THESIS_EVIDENCE_RETENTION_DAYS:'365',
  THESIS_EVIDENCE_BLOB_CONTAINER_URL:'https://thesisstore.blob.core.windows.net/trial-evidence',
  THESIS_EVIDENCE_CONTAINER_RESOURCE_ID:'/subscriptions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/resourceGroups/rg-thesis/providers/Microsoft.Storage/storageAccounts/thesisstore/blobServices/default/containers/trial-evidence'
};
const providers={getManagementToken:async()=>'management-token',getStorageToken:async()=>'storage-token'};

test('measured evidence requires a locked container policy meeting the approved duration',async()=>{
  let request;
  const store=await createMeasuredEvidenceStoreFromEnvironment({env,providers,fetchImpl:async(url,options)=>{
    request={url,authorization:options.headers.authorization};
    return new Response(JSON.stringify({properties:{state:'Locked',immutabilityPeriodSinceCreationInDays:400}}),{status:200});
  }});
  assert.equal(store.policy.state,'Locked');
  assert.equal(store.policy.retentionDays,400);
  assert.match(request.url,/immutabilityPolicies\/default\?api-version=/);
  assert.equal(request.authorization,'Bearer management-token');
});

test('measured evidence fails closed for unlocked, too-short, missing, or unreadable policy',async()=>{
  assert.throws(()=>assertLockedEvidencePolicy({properties:{state:'Unlocked',immutabilityPeriodSinceCreationInDays:365}},365),/not locked/);
  assert.throws(()=>assertLockedEvidencePolicy({properties:{state:'Locked',immutabilityPeriodSinceCreationInDays:30}},365),/shorter/);
  await assert.rejects(createMeasuredEvidenceStoreFromEnvironment({env:{...env,THESIS_EVIDENCE_RETENTION_APPROVED:'false'},providers,fetchImpl:async()=>{throw new Error('unused');}}),/not asserted/);
  await assert.rejects(createMeasuredEvidenceStoreFromEnvironment({env,providers,fetchImpl:async()=>new Response('',{status:404})}),/could not be read/);
});

test('evidence endpoint and management resource must identify the same private study container',async()=>{
  const mismatched={...env,THESIS_EVIDENCE_BLOB_CONTAINER_URL:'https://other.blob.core.windows.net/trial-evidence'};
  await assert.rejects(createMeasuredEvidenceStoreFromEnvironment({env:mismatched,providers,fetchImpl:async()=>{throw new Error('unused');}}),/does not match/);
});
