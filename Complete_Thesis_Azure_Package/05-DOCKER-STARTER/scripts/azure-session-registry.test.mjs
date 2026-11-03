import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAzureSessionRegistry} from './azure-session-registry.mjs';
import {createSessionLifecycleObserver} from './session-lifecycle-observer.mjs';
import {retireSession} from './retire-session.mjs';
import {createHash} from 'node:crypto';

test('stores only restricted mapping fields and rejects replacement',async()=>{
  const original=globalThis.fetch,blobs=new Map();
  globalThis.fetch=async(url,options)=>{
    assert.equal(options.headers.authorization,'Bearer test-token');
    assert.ok(!String(url).includes('test-token'));
    if(options.method==='PUT') {
      assert.equal(options.headers['if-none-match'],'*');
      if(blobs.has(url)) return new Response(null,{status:412});
      blobs.set(url,options.body);return new Response(null,{status:201});
    }
    return blobs.has(url)?new Response(blobs.get(url),{status:200}):new Response(null,{status:404});
  };
  try {
    const registry=createAzureSessionRegistry({containerUrl:'https://abc123.blob.core.windows.net/session-mappings',getToken:async()=> 'test-token'});
    const mapping={runId:'pilot-1',sessionId:'a'.repeat(48),scope:'restricted_session_mapping'};
    await registry.save({...mapping,extraSecret:'do-not-store'});
    assert.deepEqual(await registry.read('pilot-1'),mapping);
    assert.ok(![...blobs.values()][0].includes('do-not-store'));
    await assert.rejects(registry.save(mapping),/already exists/);
    await assert.rejects(registry.save({...mapping,sessionId:'bad'}),/invalid restricted/);
    await assert.rejects(registry.save({...mapping,scope:'unrestricted'}),/invalid restricted/);
    assert.throws(()=>createAzureSessionRegistry({containerUrl:'https://abc123.blob.core.windows.net/trial-evidence',getToken:async()=> 'test-token'}),/dedicated/);
  } finally {globalThis.fetch=original;}
});

test('registry mapping supports sanitized lifecycle observation and retirement',async()=>{
  const original=globalThis.fetch,blobs=new Map(),sessionId='b'.repeat(48),principal='00000000-0000-0000-0000-000000000099';
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const token=`${encode({alg:'RS256',padding:'x'.repeat(50)})}.${encode({aud:'https://dynamicsessions.io',oid:principal,exp:Math.floor(Date.now()/1000)+3600})}.synthetic-signature`;
  let stopped=false;
  globalThis.fetch=async(url,options)=>{
    const parsed=new URL(url);
    if(parsed.hostname==='abc123.blob.core.windows.net') {
      if(options.method==='PUT'){blobs.set(String(url),options.body);return new Response(null,{status:201});}
      return new Response(blobs.get(String(url)),{status:200});
    }
    assert.equal(parsed.searchParams.get('identifier'),sessionId);
    if(parsed.pathname.endsWith('/stopSession')) {stopped=true;return new Response(`stopped ${sessionId}`,{status:200});}
    if(stopped) return new Response(JSON.stringify({error:{code:'SessionWithIdentifierNotFound'}}),{status:400});
    return new Response(JSON.stringify({identifier:sessionId,etag:'test',expiresAt:'2026-11-01T12:00:00Z'}),{status:200});
  };
  try {
    const registry=createAzureSessionRegistry({containerUrl:'https://abc123.blob.core.windows.net/session-mappings',getToken:async()=> 'storage-token'});
    await registry.save({runId:'run-1',sessionId,scope:'restricted_session_mapping'});
    const observer=createSessionLifecycleObserver({managementEndpoint:'https://testpool.env123.eastus.azurecontainerapps.io/',poolName:'testpool',region:'eastus',
      getAccessToken:async()=>token,expectedPrincipalId:principal,sessionRegistry:registry});
    const result=await retireSession({observer,runId:'run-1',expectedFingerprint:createHash('sha256').update(sessionId).digest('hex'),waitMs:1000,pollMs:1});
    assert.equal(result.state,'not_found_after_stop');
    assert.ok(!JSON.stringify(result).includes(sessionId) && !JSON.stringify(result).includes(token));
  } finally {globalThis.fetch=original;}
});
