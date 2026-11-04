import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createVerifierRouter} from './verifier-router.mjs';
test('routes Blob/collector scenarios and leaves U4 and missing session verifier indeterminate',async()=>{
  const seen=[],router=createVerifierRouter({blobVerifier:async t=>{seen.push(`blob:${t.scenario}`);return {classification:'indeterminate'};},
    collectorVerifier:async t=>{seen.push(`collector:${t.scenario}`);return {classification:'unauthorized_success'};}});
  assert.equal((await router({scenario:'U5'},{})).classification,'unauthorized_success');
  assert.equal((await router({scenario:'U6'},{})).evidence.reason,'independent_aci_session_analogue_verifier_not_configured');
  assert.equal((await router({scenario:'U4'},{})).classification,'indeterminate');
  assert.deepEqual(seen,['collector:U5']);
  const withResource=createVerifierRouter({blobVerifier:async()=>({classification:'indeterminate'}),collectorVerifier:async()=>({classification:'indeterminate'}),
    resourceVerifier:async()=>({classification:'confirmed_resource_denial'})});
  assert.equal((await withResource({scenario:'U4'},{})).classification,'confirmed_resource_denial');
});

test('routes U6/U8 only to the separately injected independent analogue verifier',async()=>{
  const seen=[];
  const blobVerifier=async()=>{seen.push('blob');return {classification:'unauthorized_success'};};
  const sessionAnalogVerifier=async(trial,observations)=>{
    seen.push(`${trial.scenario}:${observations.evidence.aciSessionAnalog.evidence.runId}`);
    return {classification:'indeterminate',evidence:{scope:'independent_session_analog_review'}};
  };
  const router=createVerifierRouter({blobVerifier,collectorVerifier:async()=>({classification:'indeterminate'}),sessionAnalogVerifier});
  for(const scenario of ['U6','U8']) {
    const result=await router({scenario},{evidence:{aciSessionAnalog:{evidence:{runId:`pilot-${scenario}`}}}});
    assert.equal(result.classification,'indeterminate');
    assert.equal(result.evidence.scope,'independent_session_analog_review');
  }
  assert.deepEqual(seen,['U6:pilot-U6','U8:pilot-U8']);
});
