import test from 'node:test';
import assert from 'node:assert/strict';
import {createAzureVersionedProtectedEvidenceAdapter} from './azure-versioned-protected-evidence.mjs';
const sub='11111111-1111-4111-8111-111111111111';
const resourceId=`/subscriptions/${sub}/resourceGroups/rg-evidence/providers/Microsoft.Storage/storageAccounts/evidenceacct/blobServices/default/containers/evidence`;
const containerUrl='https://evidenceacct.blob.core.windows.net/evidence';
const writer='22222222-2222-4222-8222-222222222222',reader='33333333-3333-4333-8333-333333333333';
const proof={schema:'azure_blob_marker_content_proof_v1',runId:'pilot-u6-proof',scenario:'U6',resourceId:'/target',objectUri:'https://store.blob.core.windows.net/session-b/pilot-u6-proof.json',markerFingerprint:`sha256:${'a'.repeat(64)}`};
const jwt=oid=>`e30.${Buffer.from(JSON.stringify({oid})).toString('base64url')}.sig`;
function response(body,status=200,headers={}) {return new Response(body,{status,headers});}
const policyResponse=days=>response(JSON.stringify({properties:{state:'Locked',immutabilityPeriodSinceCreationInDays:days}}));
const lockedBlobHeaders=versionId=>({'x-ms-version-id':versionId,'x-ms-immutability-policy-mode':'locked',
  'x-ms-immutability-policy-until-date':new Date(Date.now()+400*86400000).toUTCString()});
function make(fetchImpl,opts={}) {return createAzureVersionedProtectedEvidenceAdapter({containerUrl,containerResourceId:resourceId,
  writerPrincipalId:writer,readerPrincipalId:reader,minimumRetentionDays:180,getWriterToken:async()=>jwt(writer),
  getReaderToken:async()=>jwt(reader),getManagementToken:async()=>'management-token',fetchImpl,...opts});}

test('version-pins a snapshot write and independently reloads the locked retained version',async()=>{
  const calls=[];let stored;
  const adapter=make(async(url,init)=>{
    calls.push({url:String(url),init});
    if(String(url).includes('immutabilityPolicies')) return response(JSON.stringify({properties:{state:'Locked',immutabilityPeriodSinceCreationInDays:365}}));
    if(init.method==='PUT') {stored=JSON.parse(init.body);return response('',201,{'x-ms-version-id':'version-123'});}
    assert.equal(new URL(String(url)).searchParams.get('versionid'),'version-123');
    return response(JSON.stringify(stored),200,lockedBlobHeaders('version-123'));
  });
  const written=await adapter.writeProtectedEvidence({snapshot:proof,observerPrincipalId:reader});
  const loaded=await adapter.loadProtectedEvidence({reference:written.reference,observerPrincipalId:reader});
  assert.equal(loaded.reference,written.reference);
  assert.equal(loaded.readerPrincipalId,reader);
  assert.equal(loaded.immutable,true);
  assert.equal(loaded.retentionPolicyState,'Locked');
  assert.equal(loaded.retentionDays,365);
  assert.equal(loaded.versionId,'version-123');
  assert.deepEqual(loaded.snapshot,proof);
  assert.equal(calls.filter(call=>call.init.method==='PUT').length,1);
  assert.equal(calls.filter(call=>call.init.method==='GET').length,1);
});

test('rejects unlocked or too-short retention and missing Blob version IDs',async()=>{
  const unlocked=make(async()=>response(JSON.stringify({properties:{state:'Unlocked',immutabilityPeriodSinceCreationInDays:365}})));
  await assert.rejects(unlocked.writeProtectedEvidence({snapshot:proof,observerPrincipalId:reader}),/not locked/);
  let count=0;
  const noVersion=make(async(url,init)=>{
    if(String(url).includes('immutabilityPolicies')) return response(JSON.stringify({properties:{state:'Locked',immutabilityPeriodSinceCreationInDays:90}}));
    count++;return response('',201);
  });
  await assert.rejects(noVersion.writeProtectedEvidence({snapshot:proof,observerPrincipalId:reader}),/not locked for the required retention/);
  assert.equal(count,0);
  const missingVersion=make(async(url,init)=>String(url).includes('immutabilityPolicies')?policyResponse(365):response('',201));
  await assert.rejects(missingVersion.writeProtectedEvidence({snapshot:proof,observerPrincipalId:reader}),/did not return a Blob version ID/);
});

test('rejects shared identities, wrong token principals, unpinned refs, and altered evidence',async()=>{
  assert.throws(()=>make(async()=>response('{}'),{writerPrincipalId:reader}),/separate identities/);
  const wrongToken=make(async(url,init)=>String(url).includes('immutabilityPolicies')?policyResponse(365):response('{}'),{getWriterToken:async()=>jwt(reader)});
  await assert.rejects(wrongToken.writeProtectedEvidence({snapshot:proof,observerPrincipalId:reader}),/token principal/);
  const adapter=make(async(url,init)=>String(url).includes('immutabilityPolicies')?policyResponse(365):response('{}',200,lockedBlobHeaders('v1')));
  await assert.rejects(adapter.loadProtectedEvidence({reference:`${containerUrl}/proofs/pilot-U6-${'a'.repeat(36)}.json`,observerPrincipalId:reader}),/outside the versioned/);
  const written=await make(async(url,init)=>String(url).includes('immutabilityPolicies')?policyResponse(365):
    init.method==='PUT'?response('',201,{'x-ms-version-id':'v1'}):response(JSON.stringify({snapshot:proof,snapshotFingerprint:`sha256:${'b'.repeat(64)}`}),200,{'x-ms-version-id':'v1'}))
    .writeProtectedEvidence({snapshot:proof,observerPrincipalId:reader});
  const altered=make(async(url,init)=>String(url).includes('immutabilityPolicies')?policyResponse(365):
    response(JSON.stringify({snapshot:proof,snapshotFingerprint:`sha256:${'b'.repeat(64)}`,writtenAt:new Date().toISOString()}),200,lockedBlobHeaders('v1')));
  await assert.rejects(altered.loadProtectedEvidence({reference:written.reference,observerPrincipalId:reader}),/hash mismatch/);
});
