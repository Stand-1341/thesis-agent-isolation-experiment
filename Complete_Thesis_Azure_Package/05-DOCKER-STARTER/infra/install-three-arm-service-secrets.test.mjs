import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {installThreeArmServiceCredentials,validateProtectedPathStat} from './install-three-arm-service-secrets.mjs';
import {threeArmSecretNames,THREE_ARM_HOST_SECRETS} from './provision-three-arm-secrets.mjs';

const vaultUrl='https://test-vault.vault.azure.net/';
const identityClientId='11111111-1111-4111-8111-111111111111';
const namePrefix='th3arm';
function credentials({mismatchProfile=false}={}) {
  const route=threeArmSecretNames(namePrefix),values=new Map();
  for(const profile of ['P1','P2','P3']) for(const name of route[profile])
    values.set(name,`profile-${profile.toLowerCase()}-secret-012345678901234567890123456789`);
  if(mismatchProfile) values.set(route.P2[2],'mismatch-p2-secret-012345678901234567890123456789');
  for(const [index,name] of THREE_ARM_HOST_SECRETS.entries())
    values.set(name,`host-secret-${index}-012345678901234567890123456789`);
  return values;
}
function makeFetch(values,{missingName,requests=[]}={}) {
  return async(url,options)=>{
    requests.push({url:String(url),options});
    if(String(url).startsWith('http://169.254.169.254/')) {
      const target=new URL(String(url));
      assert.equal(target.searchParams.get('client_id'),identityClientId);
      assert.equal(options.headers.Metadata,'true');
      return new Response(JSON.stringify({access_token:'synthetic-vault-access-token'}),{status:200});
    }
    assert.equal(options.method,'GET');
    assert.equal(options.headers.authorization,'Bearer synthetic-vault-access-token');
    const name=decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1));
    if(name===missingName || !values.has(name)) return new Response('',{status:404});
    return new Response(JSON.stringify({value:values.get(name)}),{status:200});
  };
}
async function makeEnvironmentDirectory(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'thesis-host-secrets-'));
  t.after(async()=>{
    const tempRoot=path.resolve(os.tmpdir()),target=path.resolve(directory);
    if(target.startsWith(tempRoot+path.sep)) await fs.rm(target,{recursive:true,force:true});
  });
  const fsImpl={...fs,open:async(target,flags,mode)=>{
    if(path.resolve(String(target))===path.resolve(directory) && flags==='r') return {sync:async()=>{},close:async()=>{}};
    return fs.open(target,flags,mode);
  }};
  return {directory,fsImpl};
}
function optionsFor(directory,fsImpl,values,extra={}) {
  return {vaultUrl,identityClientId,namePrefix,envDirectory:directory,fsImpl,isRoot:()=>true,
    validateDirectory:()=>{},validateFile:()=>{},fetchImpl:makeFetch(values),...extra};
}

test('host delivery retrieves explicit identity secrets and writes protected service environments idempotently',async t=>{
  const {directory,fsImpl}=await makeEnvironmentDirectory(t),values=credentials(),requests=[];
  const options=optionsFor(directory,fsImpl,values,{fetchImpl:makeFetch(values,{requests})});
  const first=await installThreeArmServiceCredentials(options);
  assert.deepEqual(first.written,['resource.env','collector.env']);
  assert.deepEqual(first.alreadyCurrent,[]);
  assert.equal(requests.length,14,'one IMDS request and thirteen Key Vault reads');
  assert.equal(requests[0].options.headers.Metadata,'true');
  const resource=await fs.readFile(path.join(directory,'resource.env'),'utf8');
  const collector=await fs.readFile(path.join(directory,'collector.env'),'utf8');
  assert.match(resource,/RESEARCH_SERVICE_MODE="azure-pilot"/);
  assert.match(resource,/P1_TOKEN="profile-p1-secret-/);
  assert.match(resource,/P2_TOKEN="profile-p2-secret-/);
  assert.match(resource,/P3_TOKEN="profile-p3-secret-/);
  assert.match(resource,/RESOURCE_JOURNAL_PATH="\/srv\/thesis-data\/resource\/events\.jsonl"/);
  assert.match(collector,/COLLECTOR_JOURNAL_PATH="\/srv\/thesis-data\/collector\/events\.jsonl"/);
  assert.equal(resource.includes('synthetic-vault-access-token'),false);
  assert.equal(JSON.stringify(first).includes('profile-p1-secret'),false);
  const second=await installThreeArmServiceCredentials(optionsFor(directory,fsImpl,values));
  assert.deepEqual(second.written,[]);
  assert.deepEqual(new Set(second.alreadyCurrent),new Set(['resource.env','collector.env']));
});

test('missing or mismatched Key Vault secrets stop before any service environment write',async t=>{
  for(const scenario of [
    {values:credentials(),missingName:threeArmSecretNames(namePrefix).P3[1],error:/HTTP 404/},
    {values:credentials({mismatchProfile:true}),error:/route secrets for P2 do not match/}
  ]) {
    const {directory,fsImpl}=await makeEnvironmentDirectory(t);
    const fetchImpl=makeFetch(scenario.values,{missingName:scenario.missingName});
    await assert.rejects(installThreeArmServiceCredentials(optionsFor(directory,fsImpl,scenario.values,{fetchImpl})),scenario.error);
    assert.equal(await fs.readdir(directory).then(entries=>entries.length),0);
  }
});

test('existing differing service environment file is not overwritten and its peer is not created',async t=>{
  const {directory,fsImpl}=await makeEnvironmentDirectory(t),values=credentials();
  const resourcePath=path.join(directory,'resource.env');
  await fs.writeFile(resourcePath,'existing=do-not-overwrite\n');
  await assert.rejects(installThreeArmServiceCredentials(optionsFor(directory,fsImpl,values)),/differs from the retrieved credentials; refusing to replace/);
  assert.equal(await fs.readFile(resourcePath,'utf8'),'existing=do-not-overwrite\n');
  assert.equal((await fs.readdir(directory)).includes('collector.env'),false);
});

test('non-root invocation and absent explicit managed identity fail before network requests',async t=>{
  const {directory,fsImpl}=await makeEnvironmentDirectory(t);
  let calls=0;
  const fetchImpl=async()=>{calls++;return new Response('',{status:500});};
  await assert.rejects(installThreeArmServiceCredentials(optionsFor(directory,fsImpl,credentials(),{isRoot:()=>false,fetchImpl})),/must run as root/);
  await assert.rejects(installThreeArmServiceCredentials({...optionsFor(directory,fsImpl,credentials(),{fetchImpl}),identityClientId:undefined}),/explicit attached managed identity client ID/);
  assert.equal(calls,0);
});

test('protected path metadata requires root ownership and exact restrictive modes',()=>{
  const directoryStat={uid:0,gid:0,mode:0o40700,isDirectory:()=>true,isSymbolicLink:()=>false};
  const fileStat={uid:0,gid:0,mode:0o100600,isFile:()=>true,isSymbolicLink:()=>false};
  assert.doesNotThrow(()=>validateProtectedPathStat(directoryStat,{kind:'directory'}));
  assert.doesNotThrow(()=>validateProtectedPathStat(fileStat,{kind:'file'}));
  assert.throws(()=>validateProtectedPathStat({...directoryStat,mode:0o40755},{kind:'directory'}),/mode 0700/);
  assert.throws(()=>validateProtectedPathStat({...fileStat,mode:0o100644},{kind:'file'}),/mode 0600/);
  assert.throws(()=>validateProtectedPathStat({...fileStat,uid:1000},{kind:'file'}),/root-owned/);
});
