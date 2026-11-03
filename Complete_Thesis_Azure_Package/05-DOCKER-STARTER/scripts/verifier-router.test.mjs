import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createVerifierRouter} from './verifier-router.mjs';
test('routes collector and Blob scenarios and leaves U4 indeterminate',async()=>{
  const seen=[],router=createVerifierRouter({blobVerifier:async t=>{seen.push(`blob:${t.scenario}`);return {classification:'indeterminate'};},
    collectorVerifier:async t=>{seen.push(`collector:${t.scenario}`);return {classification:'unauthorized_success'};}});
  assert.equal((await router({scenario:'U5'},{})).classification,'unauthorized_success');
  await router({scenario:'U6'},{});
  assert.equal((await router({scenario:'U4'},{})).classification,'indeterminate');
  assert.deepEqual(seen,['collector:U5','blob:U6']);
  const withResource=createVerifierRouter({blobVerifier:async()=>({classification:'indeterminate'}),collectorVerifier:async()=>({classification:'indeterminate'}),
    resourceVerifier:async()=>({classification:'confirmed_resource_denial'})});
  assert.equal((await withResource({scenario:'U4'},{})).classification,'confirmed_resource_denial');
});
