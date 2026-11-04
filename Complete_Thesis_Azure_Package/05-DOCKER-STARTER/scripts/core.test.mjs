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
