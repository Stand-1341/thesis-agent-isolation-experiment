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
  await assert.rejects(createMeasuredEvidenceStoreFromEnvironment({env:{...env,THESIS_EVIDENCE_RETENTION_APPROVED:'false'},providers,fetchImpl:async()=>{throw new Error('unused');}}),/applicable explicit owner-directed retention basis is required/);
  await assert.rejects(createMeasuredEvidenceStoreFromEnvironment({env,providers,fetchImpl:async()=>new Response('',{status:404})}),/could not be read/);
});

test('owner retention exception requires its exact non-counted ACI 50 scope and reference',async()=>{
  const ownerEnv={...env,THESIS_EVIDENCE_RETENTION_APPROVED:'false',THESIS_EVIDENCE_RETENTION_DAYS:'146000',
    THESIS_EVIDENCE_RETENTION_OWNER_APPROVED:'true',
    THESIS_EVIDENCE_RETENTION_OWNER_APPROVAL_SCOPE:'aci_p1_live_injection_50_non_counted_synthetic_pilot_only',
    THESIS_EVIDENCE_RETENTION_OWNER_APPROVAL_REFERENCE:'file:docs/ACI-P1-50-RETENTION-OWNER-DIRECTION.md'};
  const store=await createMeasuredEvidenceStoreFromEnvironment({env:ownerEnv,allowOwnerApprovedNonCountedPilot:true,
    ownerApprovalReference:'file:docs/ACI-P1-50-RETENTION-OWNER-DIRECTION.md',providers,
    fetchImpl:async()=>new Response(JSON.stringify({properties:{state:'Locked',immutabilityPeriodSinceCreationInDays:146000}}),{status:200})});
  assert.deepEqual(store.policy,{state:'Locked',retentionDays:146000});
  await assert.rejects(createMeasuredEvidenceStoreFromEnvironment({env:ownerEnv,allowOwnerApprovedNonCountedPilot:false,
    ownerApprovalReference:'file:docs/ACI-P1-50-RETENTION-OWNER-DIRECTION.md',providers,
    fetchImpl:async()=>{throw new Error('unused');}}),/applicable explicit owner-directed retention basis is required/);
});

test('rev4 measured retention accepts only the exact owner-directed study scope and document reference',async()=>{
  const rev4OwnerEnv={...env,THESIS_EVIDENCE_RETENTION_APPROVED:'false',THESIS_EVIDENCE_RETENTION_DAYS:'146000',
    THESIS_EVIDENCE_RETENTION_OWNER_APPROVED:'true',
    THESIS_EVIDENCE_RETENTION_OWNER_APPROVAL_SCOPE:'rev4_owner_directed_measured_study',
    THESIS_EVIDENCE_RETENTION_OWNER_APPROVAL_REFERENCE:'file:docs/400-REV4-OWNER-DIRECTED-RETENTION.md'};
  const options={env:rev4OwnerEnv,allowOwnerDirectedRev4Study:true,
    ownerDirectionReference:'file:docs/400-REV4-OWNER-DIRECTED-RETENTION.md',providers,
    fetchImpl:async()=>new Response(JSON.stringify({properties:{state:'Locked',immutabilityPeriodSinceCreationInDays:146000}}),{status:200})};
  const store=await createMeasuredEvidenceStoreFromEnvironment(options);
  assert.deepEqual(store.policy,{state:'Locked',retentionDays:146000});
  await assert.rejects(createMeasuredEvidenceStoreFromEnvironment({...options,allowOwnerDirectedRev4Study:false}),/applicable explicit owner-directed retention basis is required/);
  await assert.rejects(createMeasuredEvidenceStoreFromEnvironment({...options,ownerDirectionReference:'file:docs/other.md'}),/applicable explicit owner-directed retention basis is required/);
  await assert.rejects(createMeasuredEvidenceStoreFromEnvironment({...options,env:{...rev4OwnerEnv,THESIS_EVIDENCE_RETENTION_OWNER_APPROVAL_SCOPE:'aci_p1_live_injection_50_non_counted_synthetic_pilot_only'}}),/applicable explicit owner-directed retention basis is required/);
});

test('rev5 IDFIX measured retention accepts only its exact owner-directed scope and record',async()=>{
  const rev5OwnerEnv={...env,THESIS_EVIDENCE_RETENTION_APPROVED:'false',THESIS_EVIDENCE_RETENTION_DAYS:'146000',
    THESIS_EVIDENCE_RETENTION_OWNER_APPROVED:'true',
    THESIS_EVIDENCE_RETENTION_OWNER_APPROVAL_SCOPE:'rev5_idfix_owner_directed_measured_study',
    THESIS_EVIDENCE_RETENTION_OWNER_APPROVAL_REFERENCE:'file:docs/400-REV5-IDFIX-OWNER-DIRECTED-RETENTION.md'};
  const options={env:rev5OwnerEnv,allowOwnerDirectedRev5IdfixStudy:true,
    ownerDirectionRev5IdfixReference:'file:docs/400-REV5-IDFIX-OWNER-DIRECTED-RETENTION.md',providers,
    fetchImpl:async()=>new Response(JSON.stringify({properties:{state:'Locked',immutabilityPeriodSinceCreationInDays:146000}}),{status:200})};
  const store=await createMeasuredEvidenceStoreFromEnvironment(options);
  assert.deepEqual(store.policy,{state:'Locked',retentionDays:146000});
  await assert.rejects(createMeasuredEvidenceStoreFromEnvironment({...options,allowOwnerDirectedRev5IdfixStudy:false}),/applicable explicit owner-directed retention basis is required/);
  await assert.rejects(createMeasuredEvidenceStoreFromEnvironment({...options,ownerDirectionRev5IdfixReference:'file:docs/other.md'}),/applicable explicit owner-directed retention basis is required/);
  await assert.rejects(createMeasuredEvidenceStoreFromEnvironment({...options,env:{...rev5OwnerEnv,
    THESIS_EVIDENCE_RETENTION_OWNER_APPROVAL_SCOPE:'rev4_owner_directed_measured_study'}}),/applicable explicit owner-directed retention basis is required/);
});

test('evidence endpoint and management resource must identify the same private study container',async()=>{
  const mismatched={...env,THESIS_EVIDENCE_BLOB_CONTAINER_URL:'https://other.blob.core.windows.net/trial-evidence'};
  await assert.rejects(createMeasuredEvidenceStoreFromEnvironment({env:mismatched,providers,fetchImpl:async()=>{throw new Error('unused');}}),/does not match/);
});
