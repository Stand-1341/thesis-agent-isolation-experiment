import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createManagedLogsTokenProvider} from './azure-managed-logs-token.mjs';

test('requires explicit audit identity and uses only the Log Analytics scope',async()=>{
  const id='00000000-0000-0000-0000-000000000001'; let selected,scope;
  const getToken=createManagedLogsTokenProvider({clientId:id,createCredential:value=>{selected=value;return {getToken:async s=>{scope=s;return {token:'synthetic'};}};}});
  assert.equal(await getToken(),'synthetic'); assert.equal(selected,id); assert.equal(scope,'https://api.loganalytics.io/.default');
  assert.throws(()=>createManagedLogsTokenProvider(),/client ID required/);
  const failed=createManagedLogsTokenProvider({clientId:id,createCredential:()=>({getToken:async()=>{throw new Error('secret');}})});
  await assert.rejects(failed(),error=>error.message==='managed audit identity unavailable');
});
