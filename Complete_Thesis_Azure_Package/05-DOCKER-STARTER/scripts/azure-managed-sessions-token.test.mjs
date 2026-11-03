import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createManagedSessionsTokenProvider} from './azure-managed-sessions-token.mjs';

test('uses only the session API scope and sanitizes token failures',async()=>{
  let request;
  const provider=createManagedSessionsTokenProvider({clientId:'00000000-0000-4000-8000-000000000001',
    createCredential:clientId=>({getToken:async scope=>{request={clientId,scope};return {token:'session.token.value'};}})});
  assert.equal(await provider(),'session.token.value');
  assert.deepEqual(request,{clientId:'00000000-0000-4000-8000-000000000001',scope:'https://dynamicsessions.io/.default'});
  const failing=createManagedSessionsTokenProvider({clientId:'00000000-0000-4000-8000-000000000001',
    createCredential:()=>({getToken:async()=>{throw new Error('secret-bearing SDK detail');}})});
  await assert.rejects(failing(),error=>error.message==='managed session identity unavailable');
  assert.throws(()=>createManagedSessionsTokenProvider({clientId:'not-a-guid'}),/client ID required/);
});
