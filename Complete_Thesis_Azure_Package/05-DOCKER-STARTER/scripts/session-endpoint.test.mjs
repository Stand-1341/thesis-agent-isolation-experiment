import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateCustomSessionEndpoint} from './session-endpoint.mjs';

test('accepts the documented custom-pool host and rejects unrelated endpoints',()=>{
  const expected={poolName:'testpool',region:'eastus'};
  assert.equal(validateCustomSessionEndpoint('https://testpool.env123.eastus.azurecontainerapps.io/',expected).hostname,
    'testpool.env123.eastus.azurecontainerapps.io');
  assert.equal(validateCustomSessionEndpoint('https://my-pool.env123.eastus.azurecontainerapps.io/',{poolName:'my-pool',region:'eastus'}).hostname,
    'my-pool.env123.eastus.azurecontainerapps.io');
  assert.throws(()=>validateCustomSessionEndpoint('https://eastus.dynamicsessions.io/',expected),/does not match/);
  assert.throws(()=>validateCustomSessionEndpoint('https://otherpool.env123.eastus.azurecontainerapps.io/',expected),/does not match/);
  assert.throws(()=>validateCustomSessionEndpoint('https://testpool.env123.westus.azurecontainerapps.io/',expected),/does not match/);
  assert.throws(()=>validateCustomSessionEndpoint('https://testpool.env123.eastus.azurecontainerapps.io/path',expected),/does not match/);
});
