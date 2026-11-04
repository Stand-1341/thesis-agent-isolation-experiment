import {createHash} from 'node:crypto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAciAgentSessionHttpCallbacks} from './aci-agent-session-http.mjs';

const sub='11111111-1111-4111-8111-111111111111';
const serviceId=`/subscriptions/${sub}/resourceGroups/rg-pilot/providers/Microsoft.Storage/storageAccounts/fixture123/blobServices/default`;
const blobEndpoint='https://fixture123.blob.core.windows.net';
const source={objectId:'22222222-2222-4222-8222-222222222222',clientId:'33333333-3333-4333-8333-333333333333'};
const probe={objectId:'44444444-4444-4444-8444-444444444444',clientId:'55555555-5555-4555-8555-555555555555'};
const cleanup={objectId:'66666666-6666-4666-8666-666666666666',clientId:'77777777-7777-4777-8777-777777777777'};
const trial={runId:'pilot-aci-u6-b01-u6-r1',scenario:'U6',deployment:'azure_container_instances',profile:'P1'};
const sourceGroup={name:`thesis-aci-p1-${'a'.repeat(24)}`,privateIp:'10.48.13.11',identityObjectId:source.objectId};
const probeGroup={name:`thesis-aci-p1-${'b'.repeat(24)}`,privateIp:'10.48.13.12',identityObjectId:probe.objectId};
const target={resourceId:`${serviceId}/containers/session-b`,objectUri:`${blobEndpoint}/session-b/${trial.runId}.json`};
const fingerprint=`sha256:${'c'.repeat(64)}`;
const etag='"blob-version"';
const now='2026-11-04T12:00:00.000Z';
const cleanupRunner=async({identity,invoke})=>({output:await invoke({name:`thesis-aci-p1-${'d'.repeat(24)}`,privateIp:'10.48.13.13',identityObjectId:identity.objectId}),cleanupConfirmed:true});
function make(fetchImpl,opts={}) {return createAciAgentSessionHttpCallbacks({controllerToken:'controller-secret-token-123456',
  blobEndpoint,blobServiceResourceId:serviceId,fetchImpl,runCleanupWithIdentity:cleanupRunner,...opts});}
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});

test('constructs without network access and requires exact Blob ARM scope',()=>{
  let calls=0;
  make(async()=>{calls++;throw new Error('no network expected');});
  assert.equal(calls,0);
  assert.throws(()=>createAciAgentSessionHttpCallbacks({controllerToken:'controller-secret-token-123456',blobEndpoint,
    blobServiceResourceId:serviceId.replace('fixture123','otheracct'),runCleanupWithIdentity:cleanupRunner}),/invalid ACI session Blob endpoint/);
});

test('seed callback captures its exact request body transiently for the protected proof writer',async()=>{
  let request;
  const callbacks=make(async(url,options)=>{
    request={url,options};
    const body=JSON.parse(options.body);
    return json({runId:body.runId,container:body.kind,statusCode:201,principalId:source.objectId,
      resourceId:target.resourceId,objectUri:target.objectUri,requestId:body.requestId,startedAt:now,
      markerFingerprint:`sha256:${createHash('sha256').update(JSON.stringify({marker:body.marker})).digest('hex')}`,etag,
      contentCapture:{bodyBase64:Buffer.from(JSON.stringify({marker:body.marker})).toString('base64'),statusCode:201,
        requestId:body.requestId,principalId:source.objectId,capturedAt:now,captureBoundary:'blob_request_body'}});
  });
  const result=await callbacks.seedMarker({trial,group:sourceGroup,identity:source,container:'session-b',target});
  assert.equal(request.url,'http://10.48.13.11:8080/session-seed');
  assert.equal(request.options.headers['x-trial-key'],'controller-secret-token-123456');
  const sent=JSON.parse(request.options.body);
  assert.match(sent.marker,/^SYNTHETIC-[a-f0-9]{64}$/);assert.match(sent.requestId,/^aci-seed-[a-f0-9]{64}$/);
  assert.equal(result.statusCode,201);assert.equal(result.principalId,source.objectId);assert.equal(result.etag,etag);
  assert.equal(result.markerFingerprint,`sha256:${createHash('sha256').update(JSON.stringify({marker:sent.marker})).digest('hex')}`);
  assert.equal(result.contentCapture.bodyBytes.toString(),JSON.stringify({marker:sent.marker}));
  await assert.rejects(callbacks.seedMarker({trial,group:{...sourceGroup,identityObjectId:probe.objectId},identity:source,container:'session-b',target}),/not bound/);
});

test('probe callback sends request ID and emits exact 403 metadata without raw Azure response',async()=>{
  let request;
  const callbacks=make(async(url,options)=>{
    request={url,options};
    return json({runId:trial.runId,scenario:'U6',statusCode:403,principalId:probe.objectId,
      resourceId:target.resourceId,objectUri:target.objectUri,requestId:JSON.parse(options.body).requestId,
      startedAt:now,observedAt:now,errorCode:'AuthorizationPermissionMismatch',body:'SYNTHETIC-must-not-propagate'});
  });
  const result=await callbacks.attemptRead({trial,group:probeGroup,identity:probe,container:'session-b',resourceId:target.resourceId,
    sourceGroup:{name:sourceGroup.name},sourceGroupMustRemainActive:true});
  assert.equal(request.url,'http://10.48.13.12:8080/run');
  assert.equal(JSON.parse(request.options.body).scenario,'U6');
  assert.equal(JSON.parse(request.options.body).requestId,result.requestId);
  assert.equal(result.statusCode,403);assert.equal(result.errorCode,'AuthorizationPermissionMismatch');
  assert.equal(result.sourceGroupActiveAtProbe,true);assert.equal(JSON.stringify(result).includes('must-not-propagate'),false);
});

test('probe callback keeps successful direct Blob response bytes in a private transient capture',async()=>{
  const marker=`SYNTHETIC-${'a'.repeat(64)}`;
  const callbacks=make(async(url,options)=>{
    const requestId=JSON.parse(options.body).requestId;
    const body=JSON.stringify({marker});
    return json({runId:trial.runId,scenario:'U6',statusCode:200,principalId:probe.objectId,
      resourceId:target.resourceId,objectUri:target.objectUri,requestId,startedAt:now,
      markerFingerprint:`sha256:${createHash('sha256').update(body).digest('hex')}`,
      contentCapture:{bodyBase64:Buffer.from(body).toString('base64'),statusCode:200,requestId,
        principalId:probe.objectId,capturedAt:now,captureBoundary:'blob_response_body'}});
  });
  const result=await callbacks.attemptRead({trial,group:probeGroup,identity:probe,container:'session-b',resourceId:target.resourceId,
    sourceGroup:{name:sourceGroup.name},sourceGroupMustRemainActive:true});
  assert.equal(result.contentCapture.bodyBytes.toString(),JSON.stringify({marker}));
  assert.equal(result.markerFingerprint,`sha256:${createHash('sha256').update(JSON.stringify({marker})).digest('hex')}`);
});

test('cleanup callback invokes a fresh identity-bound private group and requires confirmed group deletion',async()=>{
  let request;
  const callbacks=make(async(url,options)=>{
    request={url,options};
    const body=JSON.parse(options.body);
    return json({runId:body.runId,container:body.kind,resourceId:target.resourceId,objectUri:target.objectUri,
      requestId:body.requestId,startedAt:now,statusCode:202,principalId:cleanup.objectId,removed:true});
  });
  const result=await callbacks.deleteMarker({trial,container:'session-b',target,identity:cleanup,markerFingerprint:fingerprint,etag});
  assert.equal(request.url,'http://10.48.13.13:8080/session-delete');
  const sent=JSON.parse(request.options.body);
  assert.equal(sent.markerFingerprint,fingerprint);assert.equal(sent.etag,etag);assert.equal(sent.requestId,result.requestId);
  assert.equal(result.statusCode,202);assert.equal(result.removed,true);assert.equal(result.principalId,cleanup.objectId);
  const unconfirmed=make(async()=>json({runId:trial.runId,container:'session-b',resourceId:target.resourceId,
    objectUri:target.objectUri,requestId:`aci-delete-${'d'.repeat(64)}`,startedAt:now,statusCode:202,
    principalId:cleanup.objectId,removed:true}),{runCleanupWithIdentity:async({invoke,identity})=>({output:await invoke({name:`thesis-aci-p1-${'d'.repeat(24)}`,
      privateIp:'10.48.13.13',identityObjectId:identity.objectId}),cleanupConfirmed:false})});
  await assert.rejects(unconfirmed.deleteMarker({trial,container:'session-b',target,identity:cleanup,markerFingerprint:fingerprint,etag}),/absence was not independently confirmed/);
});

test('refuses public agent endpoints and unrelated blob resource/object paths',async()=>{
  const callbacks=make(async()=>json({}));
  await assert.rejects(callbacks.attemptRead({trial,group:{...probeGroup,privateIp:'8.8.8.8'},identity:probe,
    container:'session-b',resourceId:target.resourceId,sourceGroup:{name:sourceGroup.name},sourceGroupMustRemainActive:true}),/identity or target/);
  await assert.rejects(callbacks.seedMarker({trial,group:sourceGroup,identity:source,container:'session-b',
    target:{...target,resourceId:target.resourceId.replace('fixture123','otheracct')}}),/target does not match/);
  await assert.rejects(callbacks.seedMarker({trial,group:sourceGroup,identity:source,container:'session-b',
    target:{...target,objectUri:target.objectUri.replace(trial.runId,'other-run')}}),/exact run marker/);
});

