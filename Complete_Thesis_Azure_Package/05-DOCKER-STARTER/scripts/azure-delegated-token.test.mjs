import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDelegatedStorageTokenProvider} from './azure-delegated-token.mjs';
const b64=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const principal='00000000-0000-0000-0000-000000000001',nowMs=1700000000000;
const make=claims=>`${b64({alg:'RS256',padding:'x'.repeat(50)})}.${b64(claims)}.synthetic-signature`;

test('delegated token shape is bound to the storage audience and expected identity',async()=>{
  const claims={aud:'https://storage.azure.com/',oid:principal,exp:Math.floor(nowMs/1000)+3600};
  const token=make(claims);
  assert.equal(await createDelegatedStorageTokenProvider({token,expectedPrincipalId:principal,nowMs})(),token);
  assert.throws(()=>createDelegatedStorageTokenProvider({token:make({...claims,aud:'https://management.azure.com/'}),expectedPrincipalId:principal,nowMs}),/claims/);
  assert.throws(()=>createDelegatedStorageTokenProvider({token:make({...claims,exp:Math.floor(nowMs/1000)-1}),expectedPrincipalId:principal,nowMs}),/claims/);
  assert.throws(()=>createDelegatedStorageTokenProvider({token,expectedPrincipalId:'00000000-0000-0000-0000-000000000002',nowMs}),/claims/);
});
