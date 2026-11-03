import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSessionLifecycleObserver} from './session-lifecycle-observer.mjs';
const principal='00000000-0000-0000-0000-000000000099';
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const token=`${encode({alg:'RS256',padding:'x'.repeat(50)})}.${encode({aud:'https://dynamicsessions.io',oid:principal,exp:Math.floor(Date.now()/1000)+3600})}.synthetic-signature`;

test('session observations hide the identifier and distinguish stop request from confirmed absence',async()=>{
  const original=globalThis.fetch,sessionId='a'.repeat(48),calls=[];
  let stopped=false;
  globalThis.fetch=async(url,options)=>{
    calls.push(url.pathname);
    assert.equal(options.method,'POST');
    assert.equal(url.searchParams.get('identifier'),sessionId);
    assert.equal(url.searchParams.get('api-version'),'2025-02-02-preview');
    if(url.pathname.endsWith('/stopSession')) {stopped=true;return new Response(`stopped ${sessionId}`,{status:200});}
    if(stopped) return new Response(JSON.stringify({error:{code:'SessionWithIdentifierNotFound'}}),{status:400});
    return new Response(JSON.stringify({identifier:sessionId,etag:'test',expiresAt:'2026-11-01T12:00:00Z'}),{status:200});
  };
  try {
    const observer=createSessionLifecycleObserver({managementEndpoint:'https://testpool.env123.eastus.azurecontainerapps.io/',poolName:'testpool',region:'eastus',
      getAccessToken:async()=>token,expectedPrincipalId:principal,sessionRegistry:{read:async runId=>({runId,sessionId,scope:'restricted_session_mapping'})}});
    const before=await observer.observe('run-1');
    assert.equal(before.state,'present');
    assert.ok(!JSON.stringify(before).includes(sessionId) && !JSON.stringify(before).includes(token));
    await assert.rejects(observer.requestStop('run-1'),/evidence collection/);
    assert.equal((await observer.requestStop('run-1',{evidenceCollected:true})).scope,'stop_requested_not_confirmed');
    assert.equal((await observer.observe('run-1')).state,'not_found');
    assert.deepEqual(calls,['/.management/getSession','/.management/stopSession','/.management/getSession']);
  } finally {globalThis.fetch=original;}
});
