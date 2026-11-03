import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFixtureSeedClient} from './fixture-seed-client.mjs';
import {sessionSeedRequestId} from './azure-session-seed.mjs';
test('fixture client confines credentials to its configured HTTPS endpoint and validates the seed response',async()=>{
  const original=globalThis.fetch,key='x'.repeat(32),calls=[];
  globalThis.fetch=async(url,options)=>{calls.push({url:url.href,options});return new Response(JSON.stringify({scope:'fixture_session_seed_observation',runId:'run-1',kind:'session-b',requestId:sessionSeedRequestId('run-1','session-b'),status:201,serviceRequestId:'request-1',sessionFingerprint:'a'.repeat(64)}));};
  try {
    const seed=createFixtureSeedClient({endpoint:'https://fixture.example/session-seed',requestKey:key});
    const result=await seed({runId:'run-1',kind:'session-b',marker:'SYNTHETIC-test'});
    assert.equal(result.status,201);assert.equal(calls[0].url,'https://fixture.example/session-seed');
    assert.equal(calls[0].options.headers['x-fixture-key'],key);assert.equal(calls[0].options.redirect,'error');
    assert.throws(()=>createFixtureSeedClient({endpoint:'http://fixture.example/session-seed',requestKey:key}),/invalid/);
    globalThis.fetch=async()=>new Response(JSON.stringify({...result,extra:key}));
    await assert.rejects(seed({runId:'run-1',kind:'session-b',marker:'SYNTHETIC-test'}),/invalid fixture service response/);
  } finally {globalThis.fetch=original;}
});
