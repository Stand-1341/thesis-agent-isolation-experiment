import {test} from 'node:test';
import assert from 'node:assert/strict';
import {estimate} from './estimate-model-cost.mjs';

test('calculates a transparent token-cost scenario and rejects invalid usage',()=>{
  const result=estimate({calls:450,inputTokens:10000,outputTokens:2000});
  assert.equal(result.totalInputTokens,4500000);
  assert.equal(result.totalOutputTokens,900000);
  assert.ok(Math.abs(result.estimatedUsd-2.925)<1e-10);
  assert.throws(()=>estimate({calls:-1,inputTokens:1,outputTokens:1}),RangeError);
  assert.throws(()=>estimate({calls:1,inputTokens:1.5,outputTokens:1}),RangeError);
});
