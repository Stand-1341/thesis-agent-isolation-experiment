import test from 'node:test';
import assert from 'node:assert/strict';
import {main} from './postup.mjs';

const sink=()=>({value:'',write(value){this.value+=value;}});

test('postup always writes readiness after validation failure and preserves the validation exit',async()=>{
  const calls=[],stderr=sink();
  const code=await main({env:{},stdout:sink(),stderr,
    validateStep:async()=>{calls.push('validate');return 3;},
    readinessStep:async()=>{calls.push('readiness');return 0;}});
  assert.equal(code,3);
  assert.deepEqual(calls,['validate','readiness']);
  assert.equal(stderr.value,'');
});

test('postup still reports after validation throws',async()=>{
  const calls=[],stderr=sink();
  const code=await main({env:{},stdout:sink(),stderr,
    validateStep:async()=>{calls.push('validate');throw new Error('probe crash');},
    readinessStep:async()=>{calls.push('readiness');return 0;}});
  assert.equal(code,4);
  assert.deepEqual(calls,['validate','readiness']);
  assert.match(stderr.value,/validation crashed: probe crash/);
});

test('postup returns a readiness failure because no manifest was emitted',async()=>{
  const code=await main({env:{},stdout:sink(),stderr:sink(),
    validateStep:async()=>0,readinessStep:async()=>5});
  assert.equal(code,5);
});
