import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {publishFunctions} from './publish-functions.mjs';

const subscription='11111111-1111-4111-8111-111111111111';
const digest=`sha256:${'a'.repeat(64)}`;
const routes=Object.fromEntries(['p1','p2','p3'].map(profile=>[profile.toUpperCase(),{
  resourceId:`/subscriptions/${subscription}/resourceGroups/rg/providers/Microsoft.Web/sites/thesis-functions-${profile}`
}]));
const outputs={workloadTokenVaultName:'study-vault',experimentConfigRoutes:{azure_functions_flex:routes}};
const triggers=[{name:'thesisNetworkProbe'},{name:'thesisSessionSeed'},{name:'thesisRun'}];

function sink() {
  return {value:'',write(value){this.value+=value;}};
}

async function fixture(t,{version='v3'}={}) {
  const dir=await mkdtemp(path.join(tmpdir(),'functions-publish-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const scratch=path.join(dir,'scratch');
  await (await import('node:fs/promises')).mkdir(scratch);
  return {dir,scratch,env:{AZURE_ENV_NAME:`functions-test-${version}`,AGENT_IMAGE_DIGEST:digest,
    THESIS_RESEARCH_CA_CERT:path.join(dir,'research-ca.pem')}};
}

test('Functions publication deploys once, verifies triggers, and stores profile keys without logging them',async t=>{
  const {dir,scratch,env}=await fixture(t);
  const calls=[],fetchCalls=[],stdout=sink(),stderr=sink();
  const secret='k'.repeat(32);
  const az=async args=>{
    calls.push(args);
    if(args[0]==='functionapp'&&args[1]==='deployment') return {};
    if(args[0]==='functionapp'&&args[1]==='function'&&args[2]==='keys') return {default:secret};
    if(args[0]==='functionapp'&&args[1]==='function'&&args[2]==='list') return triggers;
    if(args[0]==='account'&&args[1]==='get-access-token') return {accessToken:'vault-token'};
    throw new Error(`unexpected az call: ${args.join(' ')}`);
  };
  const fetchImpl=async (url,options)=>{fetchCalls.push({url,options});return {ok:true,status:200};};
  const build=async()=>({scratch,zip:path.join(scratch,'functions.zip'),packageSha256:'b'.repeat(64)});
  const options={env,az,stdout,stderr,outputs,build,fetchImpl,stateDir:dir};
  assert.equal(await publishFunctions(options),0,stderr.value);
  assert.equal(calls.filter(args=>args[1]==='deployment').length,3);
  assert.equal(fetchCalls.length,3);
  assert.deepEqual(fetchCalls.map(item=>item.url).sort(),[
    'https://study-vault.vault.azure.net/secrets/functions-p1-function-key?api-version=7.4',
    'https://study-vault.vault.azure.net/secrets/functions-p2-function-key?api-version=7.4',
    'https://study-vault.vault.azure.net/secrets/functions-p3-function-key?api-version=7.4'
  ]);
  assert.ok(fetchCalls.every(item=>item.options.headers.authorization==='Bearer vault-token'));
  assert.ok(fetchCalls.every(item=>item.options.body===JSON.stringify({value:secret})));
  assert.equal(stderr.value,'');
  assert.equal(stdout.value.includes(secret),false);
  const state=JSON.parse(await readFile(path.join(dir,'functions-publish.json'),'utf8'));
  assert.deepEqual(Object.keys(state.packages['b'.repeat(64)].routes),['P1','P2','P3']);

  calls.length=0;fetchCalls.length=0;
  assert.equal(await publishFunctions(options),0,stderr.value);
  assert.equal(calls.filter(args=>args[1]==='deployment').length,0);
  assert.equal(fetchCalls.length,3);
});

test('Functions publication skips an ACA Jobs deployment before requiring Functions-only inputs',async t=>{
  const {dir}=await fixture(t);
  const stderr=sink(),stdout=sink();
  let built=false;
  const code=await publishFunctions({env:{AZURE_ENV_NAME:'aca-jobs-test'},stdout,stderr,
    outputs:{experimentConfigRoutes:{azure_container_apps_jobs:{P1:{correlationId:'p1'}}}},
    build:async()=>{built=true;},stateDir:dir});
  assert.equal(code,0);
  assert.equal(built,false);
  assert.match(stdout.value,/skipped/);
  assert.equal(stderr.value,'');
});

test('Functions publication fails closed when the deterministic package cannot be built',async t=>{
  const {dir,env}=await fixture(t);
  const stderr=sink();
  const code=await publishFunctions({env,stdout:sink(),stderr,outputs,
    build:async()=>{throw new Error('zip build failed');},stateDir:dir});
  assert.equal(code,4);
  assert.match(stderr.value,/package build failed: zip build failed/);
});

test('Functions publication verifies triggers when the ZIP command times out',async t=>{
  const {dir,scratch,env}=await fixture(t);
  const build=async()=>({scratch,zip:path.join(scratch,'functions.zip'),packageSha256:'c'.repeat(64)});
  let fetchCalls=0;
  const fetchImpl=async()=>{fetchCalls++;return {ok:true,status:200};};
  const code=await publishFunctions({env,stdout:sink(),stderr:sink(),outputs,build,fetchImpl,stateDir:path.join(dir,'zip-failure'),
    az:async args=>{
      if(args[1]==='deployment') throw new Error('403 SCM restricted');
      if(args[1]==='function'&&args[2]==='list') return triggers;
      if(args[1]==='function'&&args[2]==='keys') return {default:'k'.repeat(32)};
      return {accessToken:'token'};
    }});
  assert.equal(code,0);
  assert.equal(fetchCalls,3);

  let listCalls=0,sleeps=0;
  const oneRoute={...outputs,experimentConfigRoutes:{azure_functions_flex:{P1:routes.P1}}};
  const notIndexed=await publishFunctions({env,stdout:sink(),stderr:sink(),outputs:oneRoute,build,fetchImpl,stateDir:path.join(dir,'trigger-timeout'),
    sleepImpl:async()=>{sleeps++;},
    az:async args=>{
      if(args[1]==='deployment') return {};
      if(args[1]==='function'&&args[2]==='list') {listCalls++;return [];}
      if(args[1]==='function'&&args[2]==='keys') return {default:'k'.repeat(32)};
      return {accessToken:'token'};
    }});
  assert.equal(notIndexed,4);
  assert.equal(listCalls,12);
  assert.equal(sleeps,12);
  assert.equal(fetchCalls,3);
});
