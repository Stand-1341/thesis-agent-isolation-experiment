import {test} from 'node:test';
import assert from 'node:assert/strict';
import {withAzureBlobLeaseLock} from './azure-blob-lease-lock.mjs';

const url='https://thesislock.blob.core.windows.net/bootstrap/three-arm-secret-bootstrap.lock';
const token='storage-token-for-tests';
const leaseId='f13a98e1-518d-45be-82ed-bafeed7b732f';
function response(status,headers={}) { return new Response('',{status,headers}); }

test('lock adapter creates an empty blob, acquires infinite lease, runs, and releases in order',async()=>{
  const calls=[];let ran=0;
  const fetchImpl=async(requestUrl,options)=>{
    calls.push({url:String(requestUrl),...options});
    if(calls.length===1) return response(201);
    if(calls.length===2) return response(201,{'x-ms-lease-id':leaseId});
    return response(200);
  };
  const value=await withAzureBlobLeaseLock({blobUrl:url,token,fetchImpl,run:async()=>{ran++;return 'complete';}});
  assert.equal(value,'complete');
  assert.equal(ran,1);
  assert.equal(calls.length,3);
  assert.equal(calls[0].method,'PUT');
  assert.equal(calls[0].headers['if-none-match'],'*');
  assert.equal(calls[0].headers['x-ms-blob-type'],'BlockBlob');
  assert.equal(calls[0].body,'');
  assert.equal(calls[1].url,`${url}?comp=lease`);
  assert.equal(calls[1].headers['x-ms-lease-action'],'acquire');
  assert.equal(calls[1].headers['x-ms-lease-duration'],'-1');
  assert.equal(calls[2].headers['x-ms-lease-action'],'release');
  assert.equal(calls[2].headers['x-ms-lease-id'],leaseId);
  assert.ok(calls.every(call=>call.headers.authorization===`Bearer ${token}`));
  assert.ok(calls.every(call=>call.headers['x-ms-date']));
  assert.ok(calls.every(call=>call.body===''),'lock blob never stores a payload');
});

test('existing lock blob is accepted after conditional create returns 412',async()=>{
  const calls=[];
  const fetchImpl=async(_url,options)=>{
    calls.push(options);
    return calls.length===1?response(412):calls.length===2?response(201,{'x-ms-lease-id':leaseId}):response(200);
  };
  await withAzureBlobLeaseLock({blobUrl:url,token,fetchImpl,run:async()=>true});
  assert.equal(calls.length,3);
});

test('existing lock blob is verified with HEAD when Azure returns 409 on conditional create',async()=>{
  const calls=[];
  const fetchImpl=async(requestUrl,options)=>{
    calls.push({url:String(requestUrl),...options});
    if(calls.length===1) return response(409);
    if(calls.length===2) return response(200);
    if(calls.length===3) return response(201,{'x-ms-lease-id':leaseId});
    return response(200);
  };
  await withAzureBlobLeaseLock({blobUrl:url,token,fetchImpl,run:async()=>true});
  assert.equal(calls.length,4);
  assert.equal(calls[1].method,'HEAD');
  assert.equal(calls[1].url,url);
  assert.equal(calls[2].headers['x-ms-lease-action'],'acquire');
});

test('contention fails closed and never runs or releases without a lease ID',async()=>{
  const calls=[];let ran=0;
  const fetchImpl=async(_url,options)=>{
    calls.push(options);
    return calls.length===1?response(412):response(409);
  };
  await assert.rejects(withAzureBlobLeaseLock({blobUrl:url,token,fetchImpl,run:async()=>{ran++;}}),/could not acquire the exclusive lock lease \(HTTP 409\)/);
  assert.equal(calls.length,2);
  assert.equal(ran,0);
});

test('successful acquire without a valid lease ID fails before running',async()=>{
  const calls=[];let ran=0;
  const fetchImpl=async(_url,options)=>{
    calls.push(options);
    return calls.length===1?response(412):response(201,{'x-ms-lease-id':'not-a-guid'});
  };
  await assert.rejects(withAzureBlobLeaseLock({blobUrl:url,token,fetchImpl,run:async()=>{ran++;}}),/no valid lease ID/);
  assert.equal(ran,0);
  assert.equal(calls.length,2);
});

test('lease release runs in finally when the protected operation fails',async()=>{
  const calls=[];
  const fetchImpl=async(_url,options)=>{
    calls.push(options);
    return calls.length===1?response(412):calls.length===2?response(201,{'x-ms-lease-id':leaseId}):response(200);
  };
  await assert.rejects(withAzureBlobLeaseLock({blobUrl:url,token,fetchImpl,run:async()=>{throw new Error('do not expose internals');}}),/bootstrap operation failed while the lock was held/);
  assert.equal(calls.length,3);
  assert.equal(calls[2].headers['x-ms-lease-action'],'release');
});

test('lease release failure reports recovery requirement without leaking callback errors',async()=>{
  const calls=[];
  const fetchImpl=async(_url,options)=>{
    calls.push(options);
    return calls.length===1?response(412):calls.length===2?response(201,{'x-ms-lease-id':leaseId}):response(403);
  };
  await assert.rejects(withAzureBlobLeaseLock({blobUrl:url,token,fetchImpl,run:async()=>{throw new Error('sensitive callback detail');}}),error=>{
    assert.match(error.message,/operator recovery may be required/);
    assert.doesNotMatch(error.message,/sensitive callback detail/);
    return true;
  });
  assert.equal(calls.length,3);
});

test('invalid, non-Azure and SAS lock URLs are rejected before sending storage tokens',async()=>{
  let calls=0;
  const fetchImpl=async()=>{calls++;return response(500);};
  for(const blobUrl of ['http://thesislock.blob.core.windows.net/c/l','https://example.com/c/l',
    `${url}?sig=secret`])
    await assert.rejects(withAzureBlobLeaseLock({blobUrl,token,fetchImpl,run:async()=>{}}),/lock URL must be an HTTPS blob URL/);
  assert.equal(calls,0);
});
