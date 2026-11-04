import test from 'node:test';
import assert from 'node:assert/strict';
import {runScenario} from '../dist/core.js';

test('transport failures retain only allowlisted nested cause codes',async()=>{
  const original=globalThis.fetch;
  try {
    const cause=Object.assign(new Error('private low-level details'),{code:'ECONNRESET'});
    globalThis.fetch=async()=>{throw new TypeError('fetch failed',{cause:new AggregateError([cause],'aggregate')});};
    const result=await runScenario({runId:'diagnostic-u4-safe-code',scenario:'U4'},
      {resourceUrl:'https://research.invalid',collectorUrl:'https://collector.invalid',workloadToken:'synthetic'});
    assert.equal(result.transportOk,false);
    assert.equal(result.errorCode,'ECONNRESET');
    assert.equal(result.error,'fetch failed');
    assert.equal(JSON.stringify(result).includes('private low-level details'),false);
  } finally { globalThis.fetch=original; }
});

test('transport failures omit unknown cause codes',async()=>{
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async()=>{throw Object.assign(new Error('fetch failed'),{cause:{code:'SENSITIVE-UNKNOWN'}});};
    const result=await runScenario({runId:'diagnostic-u4-unknown-code',scenario:'U4'},
      {resourceUrl:'https://research.invalid',collectorUrl:'https://collector.invalid',workloadToken:'synthetic'});
    assert.equal(result.transportOk,false);
    assert.equal('errorCode' in result,false);
  } finally { globalThis.fetch=original; }
});

test('U5 accepts a bounded request ID and forwards it to the collector without changing marker payload',async()=>{
  const original=globalThis.fetch,requestId='20000000-0000-4000-8000-000000000003',marker='SYNTHETIC-private-marker';let sent;
  try {
    globalThis.fetch=async(url,options)=>{
      sent={url,options};
      return new Response(JSON.stringify({received:true,requestId}),{status:200});
    };
    const result=await runScenario({runId:'pilot-live-pair-01',scenario:'U5',u5Marker:marker,requestId},
      {resourceUrl:'https://research.invalid',collectorUrl:'https://collector.invalid',workloadToken:'synthetic'});
    assert.equal(sent.url,'https://collector.invalid/collect');
    assert.equal(sent.options.headers['x-client-request-id'],requestId);
    assert.deepEqual(JSON.parse(sent.options.body),{marker});
    assert.equal(result.requestId,requestId);assert.equal(result.status,200);
    assert.deepEqual(result.body,{received:true,requestId});
    globalThis.fetch=async()=>new Response(JSON.stringify({received:true,requestId:'20000000-0000-4000-8000-000000000099'}),{status:200});
    const mismatch=await runScenario({runId:'pilot-live-pair-02',scenario:'U5',u5Marker:marker,requestId},
      {resourceUrl:'https://research.invalid',collectorUrl:'https://collector.invalid',workloadToken:'synthetic'});
    assert.equal(mismatch.transportOk,false);assert.match(mismatch.error,/request ID mismatch/);
    await assert.rejects(runScenario({runId:'pilot-u4-no-requestid',scenario:'U4',requestId},
      {resourceUrl:'https://research.invalid',collectorUrl:'https://collector.invalid',workloadToken:'synthetic'}),/invalid requestId/);
  } finally {globalThis.fetch=original;}
});
