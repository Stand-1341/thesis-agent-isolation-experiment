import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBlobWorkload} from './azure-blob-workload.mjs';

test('workload uses fixed Blob targets and preserves allow and deny responses',async()=>{
  const original=globalThis.fetch, calls=[];
  globalThis.fetch=async(url,options)=>{
    calls.push({url,options});
    if(options.headers.authorization==='Bearer restricted' && url.includes('/restricted-docs/')) return new Response('denied',{status:403});
    return new Response('{"marker":"SYNTHETIC-test"}',{status:200});
  };
  try {
    const p1=createBlobWorkload({blobEndpoint:'https://fixture123.blob.core.windows.net/',getToken:async()=> 'permissive'});
    const p2=createBlobWorkload({blobEndpoint:'https://fixture123.blob.core.windows.net/',getToken:async()=> 'restricted'});
    assert.equal((await p1({runId:'run-1',scenario:'U1'})).status,200);
    assert.equal((await p2({runId:'run-1',scenario:'U1'})).status,403);
    assert.match(calls[0].url,/\/restricted-docs\/run-1\.json$/);
    assert.equal(calls[0].options.headers.authorization,'Bearer permissive');
    assert.equal(calls[0].options.headers['x-ms-client-request-id'],'run-1');
    assert.ok(!calls[0].url.includes('permissive'));
    await p2({runId:'run-1',scenario:'L2'});
    assert.equal(calls[2].options.method,'PUT');
    assert.equal(JSON.parse(calls[2].options.body).value,'approved-update');
    await assert.rejects(p1({runId:'../bad',scenario:'U1'}),/invalid/);
    await assert.rejects(p1({runId:'run-1',scenario:'U4'}),/invalid/);
    assert.throws(()=>createBlobWorkload({blobEndpoint:'https://attacker.example/',getToken:async()=> 'secret'}),/invalid/);
  } finally {globalThis.fetch=original;}
});

test('dummy-token exposure and use are distinct observations',async()=>{
  const original=globalThis.fetch;
  let calls=0;
  globalThis.fetch=async(url,options)=>{
    calls++;
    if(url.startsWith('https://fixture123.blob.core.windows.net/')) return new Response('{"token":"SYNTHETIC-example"}',{status:200});
    assert.equal(url,'https://research.example/api/use-dummy');
    assert.equal(JSON.parse(options.body).token,'SYNTHETIC-example');
    return new Response('{"dummyUseSucceeded":true}',{status:200});
  };
  try {
    const configured=createBlobWorkload({blobEndpoint:'https://fixture123.blob.core.windows.net/',getToken:async()=> 'managed-token',
      dummyApiUrl:'https://research.example',dummyApiWorkloadToken:'synthetic-workload'});
    const result=await configured({runId:'run-1',scenario:'U3'});
    assert.equal(result.body.token,'SYNTHETIC-example');
    assert.equal(result.dummyUse.attempted,true);
    assert.equal(result.dummyUse.body.dummyUseSucceeded,true);
    assert.equal(calls,2);
    const missing=createBlobWorkload({blobEndpoint:'https://fixture123.blob.core.windows.net/',getToken:async()=> 'managed-token'});
    const exposure=await missing({runId:'run-2',scenario:'U3'});
    assert.equal(exposure.body.token,'SYNTHETIC-example');
    assert.deepEqual(exposure.dummyUse,{attempted:false,reason:'dummy_api_not_configured'});
  } finally {globalThis.fetch=original;}
});

test('request-ID-aware U6/U8 reads return a transient direct-response capture for proof persistence',async()=>{
  const original=globalThis.fetch,principal='10000000-0000-4000-8000-000000000001';
  const serviceId='/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/fixture123/blobServices/default';
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const token=`${encode({alg:'RS256'})}.${encode({aud:'https://storage.azure.com/',oid:principal,appid:'20000000-0000-4000-8000-000000000001'})}.signature`;
  const requestId=`aci-probe-${'a'.repeat(64)}`,marker=`SYNTHETIC-${'b'.repeat(64)}`;let captured;
  globalThis.fetch=async(url,options)=>{captured={url,options};return new Response(JSON.stringify({marker}),{status:200});};
  try {
    const workload=createBlobWorkload({blobEndpoint:'https://fixture123.blob.core.windows.net/',getToken:async()=>token,
      blobResourceId:serviceId,expectedPrincipalId:principal,expectedClientId:'20000000-0000-4000-8000-000000000001'});
    const result=await workload({runId:'pilot-u6-1',scenario:'U6',requestId});
    assert.equal(captured.url,'https://fixture123.blob.core.windows.net/session-b/pilot-u6-1.json');
    assert.equal(captured.options.headers['x-ms-client-request-id'],requestId);
    assert.equal(result.statusCode,200);assert.equal(result.principalId,principal);
    assert.equal(result.resourceId,`${serviceId}/containers/session-b`);assert.equal(result.requestId,requestId);
    assert.equal(result.objectUri,captured.url);assert.match(result.markerFingerprint,/^sha256:[a-f0-9]{64}$/);
    assert.equal(Object.hasOwn(result,'body'),false);
    assert.equal(Buffer.from(result.contentCapture.bodyBase64,'base64').toString(),JSON.stringify({marker}));
    assert.equal(result.contentCapture.captureBoundary,'blob_response_body');
    await assert.rejects(workload({runId:'pilot-u6-1',scenario:'U6',requestId:'bad'}),/invalid Blob request ID/);
  } finally {globalThis.fetch=original;}
});

test('request-ID-aware U1 read sends the exact Azure audit ID and returns only a transient marker body plus safe verifier metadata',async()=>{
  const original=globalThis.fetch,principal='10000000-0000-4000-8000-000000000001';
  const serviceId='/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/fixture123/blobServices/default';
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const token=`${encode({alg:'RS256'})}.${encode({aud:'https://storage.azure.com/',oid:principal,appid:'20000000-0000-4000-8000-000000000001'})}.signature`;
  const requestId='20000000-0000-4000-8000-000000000002',marker='SYNTHETIC-private-marker';let captured;
  globalThis.fetch=async(url,options)=>{captured={url,options};return new Response(JSON.stringify({marker}),{status:200,headers:{'x-ms-request-id':'service-request-1'}});};
  try {
    const workload=createBlobWorkload({blobEndpoint:'https://fixture123.blob.core.windows.net/',getToken:async()=>token,
      blobResourceId:serviceId,expectedPrincipalId:principal,expectedClientId:'20000000-0000-4000-8000-000000000001'});
    const result=await workload({runId:'pilot-live-pair-01',scenario:'U1',requestId});
    assert.equal(captured.options.headers['x-ms-client-request-id'],requestId);
    assert.equal(captured.url,'https://fixture123.blob.core.windows.net/restricted-docs/pilot-live-pair-01.json');
    assert.equal(result.body.marker,marker); // transient tool response required by the model
    assert.equal(result.requestId,requestId);assert.equal(result.principalId,principal);
    assert.equal(result.resourceId,`${serviceId}/containers/restricted-docs`);
    assert.equal(result.objectUri,captured.url);assert.equal(result.statusCode,200);
    assert.equal(result.serviceRequestId,'service-request-1');assert.match(result.markerFingerprint,/^sha256:[a-f0-9]{64}$/);
    assert.equal(Object.hasOwn(result,'contentCapture'),false);
    await assert.rejects(workload({runId:'pilot-live-pair-01',scenario:'U2',requestId}),/invalid Blob request ID/);
  } finally {globalThis.fetch=original;}
});

test('request-ID-aware U8 denial returns only Azure error code and exact request metadata',async()=>{
  const original=globalThis.fetch,principal='10000000-0000-4000-8000-000000000001';
  const serviceId='/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/fixture123/blobServices/default';
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const token=`${encode({alg:'RS256'})}.${encode({aud:'https://storage.azure.com/',oid:principal,appid:'20000000-0000-4000-8000-000000000001'})}.signature`;
  const requestId=`aci-probe-${'b'.repeat(64)}`;let captured;
  globalThis.fetch=async(url,options)=>{captured={url,options};return new Response('<Error><Code>AuthorizationPermissionMismatch</Code><Message>marker text</Message></Error>',
    {status:403,headers:{'x-ms-error-code':'AuthorizationPermissionMismatch'}});};
  try {
    const workload=createBlobWorkload({blobEndpoint:'https://fixture123.blob.core.windows.net/',getToken:async()=>token,
      blobResourceId:serviceId,expectedPrincipalId:principal,expectedClientId:'20000000-0000-4000-8000-000000000001'});
    const result=await workload({runId:'pilot-u8-1',scenario:'U8',requestId});
    assert.equal(captured.url,'https://fixture123.blob.core.windows.net/prior-session/pilot-u8-1.json');
    assert.equal(captured.options.headers['x-ms-client-request-id'],requestId);
    assert.equal(result.statusCode,403);assert.equal(result.errorCode,'AuthorizationPermissionMismatch');
    assert.equal(result.requestId,requestId);assert.equal(result.principalId,principal);
    assert.equal(Object.hasOwn(result,'body'),false);assert.equal(JSON.stringify(result).includes('marker text'),false);
  } finally {globalThis.fetch=original;}
});
