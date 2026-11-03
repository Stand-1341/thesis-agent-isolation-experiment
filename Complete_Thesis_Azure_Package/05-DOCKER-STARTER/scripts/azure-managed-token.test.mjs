import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createManagedStorageTokenProvider} from './azure-managed-token.mjs';

test('uses only the fixed storage scope and sanitizes managed identity failures',async()=>{
  let scope;
  const getToken=createManagedStorageTokenProvider({createCredential:()=>({getToken:async value=>{scope=value;return {token:'synthetic'};}})});
  assert.equal(await getToken(),'synthetic');
  assert.equal(scope,'https://storage.azure.com/.default');
  const fail=createManagedStorageTokenProvider({createCredential:()=>({getToken:async()=>{throw new Error('secret in diagnostic');}})});
  await assert.rejects(fail(),error=>error.message==='managed storage identity unavailable');
  assert.throws(()=>createManagedStorageTokenProvider({clientId:'bad'}),/invalid/);
});
