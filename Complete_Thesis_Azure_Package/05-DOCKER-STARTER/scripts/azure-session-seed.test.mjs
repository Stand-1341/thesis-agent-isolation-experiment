import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deleteSessionBlob,seedSessionBlob,sessionSeedRequestId} from './azure-session-seed.mjs';

test('fixture session seeds only controlled state and does not return credentials or marker',async()=>{
  const original=globalThis.fetch,principal='00000000-0000-0000-0000-000000000001';
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const token=`${encode({alg:'RS256',padding:'x'.repeat(50)})}.${encode({aud:'https://storage.azure.com/',oid:principal,exp:Math.floor(Date.now()/1000)+3600})}.synthetic-signature`;
  let captured;
  globalThis.fetch=async(url,options)=>{captured={url,options};return new Response(null,{status:201,headers:{'x-ms-request-id':'request-1'}});};
  try {
    const marker='SYNTHETIC-example',result=await seedSessionBlob({blobEndpoint:'https://fixture123.blob.core.windows.net/',runId:'run-1',
      kind:'session-b',marker,azureAccessToken:token,expectedPrincipalId:principal});
    assert.equal(result.requestId,sessionSeedRequestId('run-1','session-b'));
    assert.match(captured.url,/\/session-b\/run-1\.json$/);
    assert.equal(captured.options.headers['if-none-match'],'*');
    assert.ok(!JSON.stringify(result).includes(token) && !JSON.stringify(result).includes(marker));
    await assert.rejects(seedSessionBlob({blobEndpoint:'https://fixture123.blob.core.windows.net/',runId:'run-1',kind:'other',marker,azureAccessToken:token,expectedPrincipalId:principal}),/invalid/);
  } finally {globalThis.fetch=original;}
});

test('managed ACI seed is identity-bound and retains a transient exact request-body capture for proof persistence',async()=>{
  const principal='00000000-0000-4000-8000-000000000001',requestId=`aci-seed-${'a'.repeat(64)}`;
  const serviceId='/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/fixture123/blobServices/default';
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const token=`${encode({alg:'RS256'})}.${encode({aud:'https://storage.azure.com/',oid:principal,appid:'00000000-0000-4000-8000-000000000002',exp:Math.floor(Date.now()/1000)+3600})}.synthetic-signature`;
  let captured;
  const result=await seedSessionBlob({blobEndpoint:'https://fixture123.blob.core.windows.net/',runId:'pilot-u6-1',kind:'session-b',
    marker:`SYNTHETIC-${'b'.repeat(64)}`,getManagedToken:async()=>token,expectedPrincipalId:principal,expectedClientId:'00000000-0000-4000-8000-000000000002',expectedResourceId:serviceId,requestId,
    fetchImpl:async(url,options)=>{captured={url,options};return new Response(null,{status:201,headers:{etag:'"seed-etag"','x-ms-request-id':'service-id'}});}});
  assert.equal(captured.url,'https://fixture123.blob.core.windows.net/session-b/pilot-u6-1.json');
  assert.equal(captured.options.headers['x-ms-client-request-id'],requestId);
  assert.equal(captured.options.headers.authorization,`Bearer ${token}`);
  assert.equal(captured.options.headers['if-none-match'],'*');
  assert.equal(JSON.parse(captured.options.body).marker,`SYNTHETIC-${'b'.repeat(64)}`);
  assert.equal(result.statusCode,201);assert.equal(result.principalId,principal);assert.equal(result.requestId,requestId);
  assert.equal(result.resourceId,`${serviceId}/containers/session-b`);
  assert.equal(result.objectUri,captured.url);assert.equal(result.etag,'"seed-etag"');
  assert.match(result.markerFingerprint,/^sha256:[a-f0-9]{64}$/);
  assert.equal(Buffer.from(result.contentCapture.bodyBase64,'base64').toString(),captured.options.body);
  assert.equal(result.contentCapture.captureBoundary,'blob_request_body');
  assert.ok(!JSON.stringify(result).includes(token));
});

test('managed ACI seed rejects identity/resource mismatches before storage writes',async()=>{
  let calls=0;
  const principal='00000000-0000-4000-8000-000000000001';
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const token=`${encode({alg:'RS256'})}.${encode({aud:'https://storage.azure.com/',oid:'00000000-0000-4000-8000-000000000002',exp:Math.floor(Date.now()/1000)+3600})}.signature`;
  const base={blobEndpoint:'https://fixture123.blob.core.windows.net/',runId:'run-2',kind:'session-b',marker:`SYNTHETIC-${'f'.repeat(64)}`,
    getManagedToken:async()=>token,expectedPrincipalId:principal,expectedClientId:'00000000-0000-4000-8000-000000000009',expectedResourceId:'/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/fixture123/blobServices/default',
    requestId:`aci-seed-${'c'.repeat(64)}`,fetchImpl:async()=>{calls++;return new Response(null,{status:201,headers:{etag:'"seed-etag"'}});}};
  await assert.rejects(seedSessionBlob(base),/token client does not match/);
  await assert.rejects(seedSessionBlob({...base,expectedResourceId:base.expectedResourceId.replace('fixture123','otheracct')}),/does not match/);
  assert.equal(calls,0);
});

test('managed ACI cleanup validates fingerprint and ETag before conditional delete and returns no marker value',async()=>{
  const principal='00000000-0000-4000-8000-000000000003',requestId=`aci-delete-${'d'.repeat(64)}`;
  const serviceId='/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/fixture123/blobServices/default';
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const token=`${encode({alg:'RS256'})}.${encode({aud:'https://storage.azure.com/',oid:principal,appid:'00000000-0000-4000-8000-000000000009',exp:Math.floor(Date.now()/1000)+3600})}.signature`;
  const calls=[];
  const result=await deleteSessionBlob({blobEndpoint:'https://fixture123.blob.core.windows.net/',runId:'pilot-u8-1',kind:'prior-session',
    markerFingerprint:`sha256:${'e'.repeat(64)}`,etag:'"seed-etag"',requestId,expectedPrincipalId:principal,expectedClientId:'00000000-0000-4000-8000-000000000009',expectedResourceId:serviceId,
    getManagedToken:async()=>token,fetchImpl:async(url,options)=>{
      calls.push({url,options});
      return options.method==='HEAD'?new Response(null,{status:200,headers:{etag:'"seed-etag"','x-ms-meta-marker-fingerprint':`sha256:${'e'.repeat(64)}`}}):new Response(null,{status:202});
    }});
  assert.equal(calls.length,2);assert.equal(calls[0].options.method,'HEAD');assert.equal(calls[0].options.headers['x-ms-client-request-id'],`${requestId}-head`);
  assert.equal(calls[1].options.method,'DELETE');assert.equal(calls[1].options.headers['if-match'],'"seed-etag"');
  assert.equal(calls[1].options.headers['x-ms-client-request-id'],requestId);
  assert.equal(result.removed,true);assert.equal(result.statusCode,202);assert.equal(result.principalId,principal);
  assert.equal(result.resourceId,`${serviceId}/containers/prior-session`);assert.ok(!JSON.stringify(result).includes('SYNTHETIC-'));
});

test('managed cleanup fails closed on a different marker hash or ETag',async()=>{
  const principal='00000000-0000-4000-8000-000000000003',serviceId='/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/fixture123/blobServices/default';
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const token=`${encode({alg:'RS256'})}.${encode({aud:'https://storage.azure.com/',oid:principal,exp:Math.floor(Date.now()/1000)+3600})}.signature`;
  let deletes=0;
  await assert.rejects(deleteSessionBlob({blobEndpoint:'https://fixture123.blob.core.windows.net/',runId:'run-3',kind:'prior-session',
    markerFingerprint:`sha256:${'e'.repeat(64)}`,etag:'"seed-etag"',requestId:`aci-delete-${'d'.repeat(64)}`,
    expectedPrincipalId:principal,expectedClientId:'00000000-0000-4000-8000-000000000009',expectedResourceId:serviceId,getManagedToken:async()=>token,
    fetchImpl:async(url,options)=>{if(options.method==='DELETE') deletes++;return new Response(null,{status:200,headers:{etag:'"other-etag"','x-ms-meta-marker-fingerprint':`sha256:${'f'.repeat(64)}`}});}}),/does not match/);
  assert.equal(deletes,0);
});
