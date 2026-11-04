import test from 'node:test';
import assert from 'node:assert/strict';
import {createAciBlobMarkerOperations} from './aci-blob-marker-operations.mjs';

const sub='11111111-1111-4111-8111-111111111111';
const serviceId=`/subscriptions/${sub}/resourceGroups/rg-pilot/providers/Microsoft.Storage/storageAccounts/thesisfixture/blobServices/default`;
const endpoint='https://thesisfixture.blob.core.windows.net';
const source={objectId:'22222222-2222-4222-8222-222222222222',clientId:'33333333-3333-4333-8333-333333333333'};
const verifier={objectId:'44444444-4444-4444-8444-444444444444',clientId:'55555555-5555-4555-8555-555555555555'};
const trial={runId:'pilot-aci-u6-b01',scenario:'U6',deployment:'azure_container_instances',profile:'P1'};
const jwt=identity=>`e30.${Buffer.from(JSON.stringify({oid:identity.objectId,appid:identity.clientId})).toString('base64url')}.signature`;
const evidence=async()=>({
  verifierAccessReview:{complete:true,includesInherited:true,httpStatus:200,readMethod:'azure_role_assignments_effective_snapshot',
    principalId:verifier.objectId,container:'session-b',observerPrincipalId:'66666666-6666-4666-8666-666666666666',
    evidenceReference:'https://evidence.example.test/reviews/one',snapshotFingerprint:`sha256:${'a'.repeat(64)}`,
    observedAt:'2026-11-04T12:00:00.000Z',effectiveRoleAssignments:[]},
  verifierEffectiveAccess:{status:'complete',runId:trial.runId,principalId:verifier.objectId,container:'session-b',
    resourceId:`${serviceId}/containers/session-b`,source:'azure_live_effective_access_evaluator_v1',httpStatus:200,readOnly:true,
    observerPrincipalId:'66666666-6666-4666-8666-666666666666',evidenceReference:'https://evidence.example.test/access/one',
    snapshotFingerprint:`sha256:${'b'.repeat(64)}`,observedAt:'2026-11-04T12:00:00.000Z',inheritanceResolved:true,
    groupMembershipsResolved:true,customRolesResolved:true,dataActionsResolved:true,indirectCredentialPathsResolved:true,
    unknownRoleDefinitions:[],hasBlobRead:true,hasBlobWrite:false,effectiveAssignments:[]}
});
function response(status,body='',headers={}) {
  return new Response(body,{status,headers});
}
function makeOps(fetchImpl,opts={}) {
  return createAciBlobMarkerOperations({blobServiceResourceId:serviceId,blobEndpoint:endpoint,verifierIdentity:verifier,
    getTokenForIdentity:async identity=>jwt(identity),readVerifierAccessEvidence:evidence,fetchImpl,
    now:()=>Date.parse('2026-11-04T12:00:00.000Z'),...opts});
}

test('resolves only the scenario-specific exact run-scoped marker target',()=>{
  const operations=makeOps(async()=>{throw new Error('unused');});
  assert.deepEqual(operations.targetForMarker({trial,container:'session-b'}),{
    resourceId:`${serviceId}/containers/session-b`,objectUri:`${endpoint}/session-b/${trial.runId}.json`});
  assert.throws(()=>operations.targetForMarker({trial,container:'prior-session'}),/match a supported/);
  assert.throws(()=>operations.targetForMarker({trial:{...trial,runId:'../escape'},container:'session-b'}),/match a supported/);
  assert.throws(()=>makeOps(async()=>{throw new Error('unused');},{blobEndpoint:'https://other.blob.core.windows.net'}),/does not match/);
});

test('writes synthetic marker once with identity-checked MI token and opaque audit request ID',async()=>{
  const requests=[];
  let markerBody;
  const ops=makeOps(async(url,init)=>{
    requests.push({url,init});markerBody=init.body;
    return response(201,'',{etag:'"etag-one"'});
  });
  const target=ops.targetForMarker({trial,container:'session-b'});
  const result=await ops.seedMarker({trial,group:{identityObjectId:source.objectId},identity:source,container:'session-b',target});
  assert.equal(result.statusCode,201);
  assert.equal(result.runId,trial.runId);
  assert.equal(result.principalId,source.objectId);
  assert.equal(result.resourceId,target.resourceId);
  assert.equal(result.objectUri,target.objectUri);
  assert.match(result.requestId,/^aci-put-[a-f0-9]{64}$/);
  assert.match(result.markerFingerprint,/^sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC-/);
  assert.equal(requests[0].init.method,'PUT');
  assert.equal(requests[0].init.headers.authorization,`Bearer ${jwt(source)}`);
  assert.equal(requests[0].init.headers['x-ms-client-request-id'],result.requestId);
  assert.equal(requests[0].init.headers['if-none-match'],'*');
  assert.equal(JSON.parse(markerBody).marker.startsWith('SYNTHETIC-'),true);
  await assert.rejects(ops.seedMarker({trial,group:{identityObjectId:source.objectId},identity:source,container:'session-b',target}),/already exists/);
  assert.equal(requests.length,1);
});

test('independent positive read returns only fingerprint and separate access evidence',async()=>{
  let markerBody;
  let seed;
  const ops=makeOps(async(url,init)=>{
    if(init.method==='PUT') {markerBody=init.body;return response(201,'',{etag:'"etag-one"'});}
    return response(200,markerBody,{'x-ms-request-id':'server-read-id'});
  });
  const target=ops.targetForMarker({trial,container:'session-b'});
  seed=await ops.seedMarker({trial,group:{identityObjectId:source.objectId},identity:source,container:'session-b',target});
  const read=await ops.readMarker({trial,container:'session-b',resourceId:target.resourceId,markerFingerprint:seed.markerFingerprint});
  assert.equal(read.matched,true);
  assert.equal(read.markerFingerprint,seed.markerFingerprint);
  assert.equal(read.verifierPrincipalId,verifier.objectId);
  assert.notEqual(read.requestId,seed.requestId);
  assert.equal(read.verifierAccessReview.readMethod,'azure_role_assignments_effective_snapshot');
  assert.equal(JSON.stringify(read).includes('SYNTHETIC-'),false);
});

test('probe classifies HTTP 403 without returning Azure body and binds request identity',async()=>{
  let request;
  const ops=makeOps(async(url,init)=>{
    request={url,init};return response(403,'<Error><Code>AuthorizationPermissionMismatch</Code><Message>hidden details</Message></Error>');
  });
  const target=ops.targetForMarker({trial,container:'session-b'});
  const group={name:'probe-group',identityObjectId:source.objectId};
  const result=await ops.attemptRead({trial,group,identity:source,container:'session-b',resourceId:target.resourceId,
    sourceGroup:{name:'source-group'},sourceGroupMustRemainActive:true});
  assert.equal(result.statusCode,403);
  assert.equal(result.errorCode,'AuthorizationPermissionMismatch');
  assert.equal(result.principalId,source.objectId);
  assert.equal(result.sourceGroupActiveAtProbe,true);
  assert.equal(request.init.headers['x-ms-client-request-id'],result.requestId);
  assert.equal(JSON.stringify(result).includes('hidden details'),false);
});

test('probe success returns only the marker fingerprint and does not disclose marker contents',async()=>{
  const marker='SYNTHETIC-'+ 'c'.repeat(64);
  let request;
  const ops=makeOps(async(url,init)=>{request={url,init};return response(200,JSON.stringify({marker}));});
  const target=ops.targetForMarker({trial,container:'session-b'});
  const result=await ops.attemptRead({trial,group:{name:'probe-group',identityObjectId:source.objectId},identity:source,
    container:'session-b',resourceId:target.resourceId,sourceGroup:{name:'source-group'},sourceGroupMustRemainActive:true});
  assert.equal(result.statusCode,200);
  assert.equal(result.markerFingerprint,`sha256:${(await import('node:crypto')).createHash('sha256').update(JSON.stringify({marker})).digest('hex')}`);
  assert.equal(JSON.stringify(result).includes(marker),false);
  assert.equal(request.init.headers.authorization,`Bearer ${jwt(source)}`);
});

test('deletes only the seeded ETag with a distinct cleanup identity and audited request ID',async()=>{
  const requests=[];
  let markerBody;
  const cleanup={objectId:'77777777-7777-4777-8777-777777777777',clientId:'88888888-8888-4888-8888-888888888888'};
  const ops=makeOps(async(url,init)=>{
    requests.push({url,init});
    if(init.method==='PUT') {markerBody=init.body;return response(201,'',{etag:'"etag-one"'});}
    if(init.method==='DELETE') return response(202,'');
    return response(200,markerBody);
  });
  const target=ops.targetForMarker({trial,container:'session-b'});
  const seed=await ops.seedMarker({trial,group:{identityObjectId:source.objectId},identity:source,container:'session-b',target});
  const deleted=await ops.deleteMarker({trial,container:'session-b',target,identity:cleanup,markerFingerprint:seed.markerFingerprint});
  assert.equal(deleted.removed,true);
  assert.equal(deleted.statusCode,202);
  assert.equal(deleted.principalId,cleanup.objectId);
  assert.notEqual(deleted.requestId,seed.requestId);
  assert.equal(requests[1].init.method,'DELETE');
  assert.equal(requests[1].init.headers['if-match'],'"etag-one"');
  assert.equal(requests[1].init.headers.authorization,`Bearer ${jwt(cleanup)}`);
  await assert.rejects(ops.deleteMarker({trial,container:'session-b',target,identity:cleanup,markerFingerprint:seed.markerFingerprint}),/target or fingerprint mismatch/);
});

test('refuses wrong identity tokens, unbound targets, and ambiguous HTTP errors',async()=>{
  const ops=makeOps(async()=>response(403,'<Error><Code>AuthorizationPermissionMismatch</Code></Error>'),{
    getTokenForIdentity:async()=>jwt(verifier)});
  const target=ops.targetForMarker({trial,container:'session-b'});
  await assert.rejects(ops.seedMarker({trial,group:{identityObjectId:source.objectId},identity:source,container:'session-b',target}),/does not match the requested identity/);
  const wrongTarget={...target,objectUri:target.objectUri.replace('session-b','authorized-docs')};
  await assert.rejects(ops.seedMarker({trial,group:{identityObjectId:source.objectId},identity:source,container:'session-b',target:wrongTarget}),/target or group identity mismatch/);
});

