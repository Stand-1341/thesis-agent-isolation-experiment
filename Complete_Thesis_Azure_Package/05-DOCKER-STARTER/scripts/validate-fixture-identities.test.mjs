import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateFixtureIdentities} from './validate-fixture-identities.mjs';

test('rejects overlapping workload and privileged principals',()=>{
  const ids=Array.from({length:12},(_,i)=>`00000000-0000-0000-0000-${String(i+1).padStart(12,'0')}`);
  const config={p1PrincipalIds:ids.slice(0,3),restrictedPrincipalIds:ids.slice(3,9),fixtureControllerPrincipalId:ids[9],verifierPrincipalId:ids[10],sessionFixtureOwnerPrincipalId:ids[11]};
  assert.equal(validateFixtureIdentities(config).workloadPrincipals,9);
  assert.throws(()=>validateFixtureIdentities({...config,fixtureControllerPrincipalId:ids[0]}),/distinct/);
  assert.throws(()=>validateFixtureIdentities({...config,sessionFixtureOwnerPrincipalId:ids[10]}),/distinct/);
  assert.throws(()=>validateFixtureIdentities({...config,restrictedPrincipalIds:ids.slice(3,8)}),/six/);
});
