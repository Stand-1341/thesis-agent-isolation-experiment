import assert from 'node:assert/strict';
import test from 'node:test';
import {createManagedKeyVaultSecretReader} from './azure-keyvault-secret.mjs';

const clientId='00000000-0000-4000-8000-000000000001';
const secretUri='https://thesis-secrets.vault.azure.net/secrets/p2-workload-token/version-1';

test('managed Key Vault reader requests the selected identity and returns only the secret value',async()=>{
  const seen=[];
  const read=createManagedKeyVaultSecretReader({clientId,
    createCredential:selected=>{assert.equal(selected,clientId);return {getToken:async scope=>{assert.equal(scope,'https://vault.azure.net/.default');return {token:'synthetic-bearer'}}};},
    fetchImpl:async(url,options)=>{
      seen.push({url:String(url),options});
      return new Response(JSON.stringify({value:'synthetic-workload-token'}),{status:200,headers:{'content-type':'application/json'}});
    }});
  assert.equal(await read(secretUri),'synthetic-workload-token');
  assert.equal(seen.length,1);
  assert.equal(seen[0].url,'https://thesis-secrets.vault.azure.net/secrets/p2-workload-token/version-1?api-version=7.4');
  assert.equal(seen[0].options.headers.authorization,'Bearer synthetic-bearer');
  assert.equal(seen[0].options.redirect,'error');
});

test('Key Vault secret URI must be HTTPS, versionless or versioned, and contain no query or fragment',async()=>{
  let credentialCalls=0;
  const read=createManagedKeyVaultSecretReader({createCredential:()=>({getToken:async()=>{credentialCalls++;return {token:'t'};}}),
    fetchImpl:async()=>new Response(JSON.stringify({value:'x'}),{status:200})});
  for(const invalid of ['http://thesis-secrets.vault.azure.net/secrets/token','https://thesis-secrets.vault.azure.net/secrets/token?x=1',
    'https://user:pass@thesis-secrets.vault.azure.net/secrets/token','https://example.com/secrets/token','https://thesis-secrets.vault.azure.net/secrets/../other'])
    await assert.rejects(()=>read(invalid),/secret URI/);
  assert.equal(credentialCalls,0);
});

test('Key Vault failures are sanitized and never leak token, response, URI, or returned secret',async()=>{
  const bearer='do-not-leak-bearer-token',secret='do-not-leak-secret',body='private-provider-response';
  const read=createManagedKeyVaultSecretReader({createCredential:()=>({getToken:async()=>({token:bearer})}),
    fetchImpl:async()=>new Response(body,{status:403})});
  await assert.rejects(()=>read(secretUri),error=>{
    for(const value of [bearer,secret,body,secretUri]) assert.equal(error.message.includes(value),false);
    return /HTTP 403/.test(error.message);
  });
  const transport=createManagedKeyVaultSecretReader({createCredential:()=>({getToken:async()=>({token:bearer})}),
    fetchImpl:async()=>{throw new Error(`${bearer} ${secretUri}`);}});
  await assert.rejects(()=>transport(secretUri),error=>{
    assert.equal(error.message.includes(bearer),false);assert.equal(error.message.includes(secretUri),false);return true;
  });
});

test('Key Vault rejects malformed or multiline secret values',async()=>{
  for(const value of ['', 'one\ntwo']) {
    const read=createManagedKeyVaultSecretReader({createCredential:()=>({getToken:async()=>({token:'t'})}),
      fetchImpl:async()=>new Response(JSON.stringify({value}),{status:200})});
    await assert.rejects(()=>read(secretUri),/invalid secret value/);
  }
});
