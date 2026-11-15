import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {provisionThreeArmSecrets} from './provision-three-arm-secrets.mjs';
import {withAzureBlobLeaseLock} from './azure-blob-lease-lock.mjs';

const vaultName='test-vault-123',namePrefix='th3arm';
const routeNames=Object.fromEntries(['P1','P2','P3'].map(profile=>[profile,
  ['vm','job','sbx'].map(route=>`${namePrefix}-${route}-${profile.toLowerCase()}-workload-token`)]));
const hostNames=['resource-admin-key','collector-admin-key','functions-p1-resource-verifier-key','functions-p1-collector-verifier-key'];
function makeHarness(existing={}) {
  const writes=[];
  const fetchImpl=async(url,options)=>{
    const name=decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1));
    if(options.method==='GET') return Object.hasOwn(existing,name)
      ?new Response(JSON.stringify({value:existing[name]}),{status:200})
      :new Response('',{status:404});
    writes.push({name,headers:options.headers,body:JSON.parse(options.body)});
    existing[name]=JSON.parse(options.body).value;
    return new Response('{}',{status:200});
  };
  let generated=0;
  const generateCredential=()=>`generated-secret-${String(++generated).padStart(2,'0')}-012345678901234567890123456789`;
  const withExclusiveLock=async operation=>operation();
  return {existing,writes,generateCredential,fetchImpl,withExclusiveLock};
}

test('selected three-arm bootstrap creates nine route names from three shared profile values plus four host credentials',async()=>{
  const h=makeHarness();
  const result=await provisionThreeArmSecrets({vaultName,namePrefix,token:'test-token',...h});
  assert.equal(result.saved.length,13);
  assert.deepEqual(result.alreadyPresent,[]);
  assert.deepEqual(result.routeSecretNames,routeNames);
  assert.deepEqual(result.hostSecretNames,hostNames);
  assert.equal(h.writes.length,13);
  for(const names of Object.values(routeNames)) {
    const values=names.map(name=>h.existing[name]);
    assert.equal(new Set(values).size,1,'all three architecture arms use their profile authorization token');
  }
  assert.equal(new Set([...Object.values(routeNames).flat(),...hostNames].map(name=>h.existing[name])).size,7,
    'profile, admin, and verifier credentials remain distinct');
  assert.ok(h.writes.every(write=>!Object.keys(write.headers).some(name=>name.toLowerCase()==='if-none-match')));
  assert.ok(result.saved.every(name=>typeof name==='string'));
  assert.equal(Object.hasOwn(result,'values'),false);
  assert.equal(JSON.stringify(result).includes('generated-secret'),false);
});

test('preprovisioned host CA private key is stored only under its dedicated secret and never returned or logged',async()=>{
  const h=makeHarness();
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:3072,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
  const result=await provisionThreeArmSecrets({vaultName,namePrefix,token:'test-token',hostTlsCaPrivateKey:privateKey,...h});
  const secretName=`${namePrefix}-host-tls-ca-private-key`;
  assert.equal(result.saved.length,14);
  assert.equal(result.hostTlsCaSecretName,secretName);
  assert.equal(h.existing[secretName],`base64:${Buffer.from(privateKey).toString('base64')}`);
  assert.equal(JSON.stringify(result).includes(privateKey),false);
  assert.equal(JSON.stringify(result).includes(h.existing[secretName]),false);
});

test('host CA bootstrap refuses to replace a different existing Key Vault key',async()=>{
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:3072,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
  const existing={[`${namePrefix}-host-tls-ca-private-key`]:'base64:YWJj'};
  const h=makeHarness(existing);
  await assert.rejects(provisionThreeArmSecrets({vaultName,namePrefix,token:'test-token',hostTlsCaPrivateKey:privateKey,...h}),/existing .* invalid|differs from the supplied key/);
  assert.equal(h.writes.length,0);
});

test('bootstrap resumes missing route entries from an existing profile value without replacing it',async()=>{
  const existing={[routeNames.P1[0]]:'existing-profile-one-token-012345678901234567890123456789'};
  const h=makeHarness(existing);
  const result=await provisionThreeArmSecrets({vaultName,namePrefix,token:'test-token',...h});
  assert.equal(h.writes.filter(write=>routeNames.P1.includes(write.name)).length,2);
  assert.deepEqual(routeNames.P1.map(name=>h.existing[name]),Array(3).fill(existing[routeNames.P1[0]]));
  assert.equal(result.alreadyPresent.includes(routeNames.P1[0]),true);
});

test('bootstrap refuses differing route values and performs no writes',async()=>{
  const existing={
    [routeNames.P1[0]]:'existing-profile-one-token-012345678901234567890123456789',
    [routeNames.P1[1]]:'different-profile-one-token-012345678901234567890123456789'
  };
  const h=makeHarness(existing);
  await assert.rejects(provisionThreeArmSecrets({vaultName,namePrefix,token:'test-token',...h}),/existing values.*differ.*refusing to overwrite/);
  assert.equal(h.writes.length,0);
});

test('bootstrap refuses a credential shared across service/profile groups and performs no writes',async()=>{
  const shared='shared-existing-token-012345678901234567890123456789';
  const existing={[routeNames.P1[0]]:shared,[hostNames[0]]:shared};
  const h=makeHarness(existing);
  await assert.rejects(provisionThreeArmSecrets({vaultName,namePrefix,token:'test-token',...h}),/credentials are shared across groups/);
  assert.equal(h.writes.length,0);
});

test('invalid existing credentials are never overwritten',async()=>{
  const h=makeHarness({[hostNames[0]]:'short'});
  await assert.rejects(provisionThreeArmSecrets({vaultName,namePrefix,token:'test-token',...h}),/existing resource-admin-key is invalid/);
  assert.equal(h.writes.length,0);
});

test('failed Key Vault write stops safely without exposing a credential',async()=>{
  let writes=0;
  const h=makeHarness();
  h.fetchImpl=async(url,options)=>{
    if(options.method==='GET') return new Response('',{status:404});
    writes++;
    assert.equal(Object.keys(options.headers).some(name=>name.toLowerCase()==='if-none-match'),false);
    return new Response('',{status:403});
  };
  await assert.rejects(provisionThreeArmSecrets({vaultName,namePrefix,token:'test-token',...h}),/could not save .*HTTP 403/);
  assert.equal(writes,1);
});

test('bootstrap refuses to write if no exclusive distributed lock adapter is supplied',async()=>{
  const h=makeHarness();
  const {withExclusiveLock,...unlocked}=h;
  await assert.rejects(provisionThreeArmSecrets({vaultName,namePrefix,token:'test-token',...unlocked}),/exclusive distributed lock adapter is required/);
  assert.equal(h.writes.length,0);
});

test('post-write verification detects an independent Key Vault writer without repairing it',async()=>{
  const h=makeHarness();
  const baseFetch=h.fetchImpl;
  let firstPut=false;
  h.fetchImpl=async(url,options)=>{
    if(options.method==='PUT' && !firstPut) {
      firstPut=true;
      const response=await baseFetch(url,options);
      const name=decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1));
      h.existing[name]='external-writer-value-012345678901234567890123456789';
      return response;
    }
    return baseFetch(url,options);
  };
  await assert.rejects(provisionThreeArmSecrets({vaultName,namePrefix,token:'test-token',...h}),/changed during provisioning.*independent writer/);
  assert.equal(h.writes.length,13,'bootstrap does not try to overwrite or repair external changes');
});

test('Key Vault bootstrap performs no reads or writes when the Blob lease is contended',async()=>{
  let lockCalls=0,keyVaultCalls=0;
  const lockFetch=async(_url,options)=>{
    lockCalls++;
    return lockCalls===1?new Response('',{status:412}):new Response('',{status:409});
  };
  const keyVaultFetch=async()=>{keyVaultCalls++;return new Response('',{status:404});};
  await assert.rejects(provisionThreeArmSecrets({vaultName,namePrefix,token:'vault-token',fetchImpl:keyVaultFetch,
    withExclusiveLock:run=>withAzureBlobLeaseLock({blobUrl:'https://thesislock.blob.core.windows.net/bootstrap/three-arm-secret-bootstrap.lock',
      token:'storage-token',fetchImpl:lockFetch,run})}),/could not acquire the exclusive lock lease/);
  assert.equal(lockCalls,2);
  assert.equal(keyVaultCalls,0);
});
