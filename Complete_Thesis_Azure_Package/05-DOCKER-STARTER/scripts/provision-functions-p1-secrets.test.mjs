import {test} from 'node:test';
import assert from 'node:assert/strict';
import {provisionPilotSecrets} from '../infra/provision-functions-p1-secrets.mjs';

const names=[
  'functions-p1-controller-key','functions-p1-function-key','resource-admin-key',
  'collector-admin-key','functions-p1-resource-verifier-key','functions-p1-collector-verifier-key'
];

test('secret helper reuses valid values and prompts only to replace the short controller key',async()=>{
  const valid=Object.fromEntries(names.map(name=>[name,`valid-secret-${name}-12345678901234567890`]));
  valid[names[0]]='too-short';
  const prompts=[],writes=[];
  const result=await provisionPilotSecrets({vaultName:'test-vault-123',token:'test-token',
    readSecret:async prompt=>{prompts.push(prompt);return 'replacement-controller-secret-12345678901234567890';},
    fetchImpl:async(url,options)=>{
      const name=decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1));
      if(options.method==='GET') return new Response(JSON.stringify({value:valid[name]}),{status:200});
      writes.push({name,authorization:options.headers.authorization,body:JSON.parse(options.body)});
      return new Response('{}',{status:200});
    }});
  assert.deepEqual(result.saved,[names[0]]);
  assert.deepEqual(result.alreadyValid,names.slice(1));
  assert.equal(prompts.length,1);
  assert.match(prompts[0],/TRIAL_REQUEST_KEY/);
  assert.equal(writes.length,1);
  assert.equal(writes[0].name,names[0]);
  assert.equal(writes[0].authorization,'Bearer test-token');
  assert.equal(writes[0].body.value,'replacement-controller-secret-12345678901234567890');
});

test('secret helper stops on the first failed Key Vault write',async()=>{
  let writes=0;
  await assert.rejects(provisionPilotSecrets({token:'test-token',readSecret:async()=>`test-secret-value-12345678901234567890`,
    fetchImpl:async(url,options)=>{
      if(options.method==='GET') return new Response('',{status:404});
      writes++;
      return new Response('',{status:403});
    }}),/could not save functions-p1-controller-key \(HTTP 403\)/);
  assert.equal(writes,1);
});

test('secret helper refuses short replacement values before writing',async()=>{
  let writes=0;
  await assert.rejects(provisionPilotSecrets({token:'test-token',readSecret:async()=> 'short',
    fetchImpl:async(url,options)=>{
      if(options.method==='GET') return new Response('',{status:404});
      writes++;
      return new Response('{}',{status:200});
    }}),/32 to 512 characters/);
  assert.equal(writes,0);
});
