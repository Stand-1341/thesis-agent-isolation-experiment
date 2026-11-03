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
