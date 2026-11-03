import {test} from 'node:test';
import assert from 'node:assert/strict';
import {provisionPilotSecrets} from '../infra/provision-functions-p1-secrets.mjs';

test('secret provisioner writes fixed names directly to Key Vault without logging values',async()=>{
  const values=['controller-value-12345678901234567890','function-value-12345678901234567890',
    'resource-admin-value-1234567890123456','collector-admin-value-1234567890123456',
    'resource-verifier-value-1234567890123456','collector-verifier-value-1234567890123456'];
  const prompts=[],requests=[];
  const saved=await provisionPilotSecrets({vaultName:'test-vault-123',token:'test-token',
    readSecret:async prompt=>{prompts.push(prompt);return values[prompts.length-1];},
    fetchImpl:async(url,options)=>{requests.push({url:String(url),options,body:JSON.parse(options.body)});return new Response('{}',{status:200});}});
  assert.deepEqual(saved,[
    'functions-p1-controller-key','functions-p1-function-key','resource-admin-key',
    'collector-admin-key','functions-p1-resource-verifier-key','functions-p1-collector-verifier-key'
  ]);
  assert.equal(requests.length,6);
  assert.equal(requests[0].options.headers.authorization,'Bearer test-token');
  assert.equal(requests[0].body.value,values[0]);
  assert.ok(requests.every(request=>request.url.startsWith('https://test-vault-123.vault.azure.net/secrets/')));
  assert.ok(prompts.every(prompt=>prompt.includes('Enter ')));
});

test('secret provisioner stops at the first failed Key Vault write',async()=>{
  let writes=0;
  await assert.rejects(provisionPilotSecrets({token:'test-token',readSecret:async()=>`test-secret-value-${++writes}`,
    fetchImpl:async()=>new Response('',{status:403})}),/could not save functions-p1-controller-key \(HTTP 403\)/);
  assert.equal(writes,1);
});
