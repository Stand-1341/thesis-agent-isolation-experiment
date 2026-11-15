import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildRemoteSetupScript,setupResearchHost} from './research-host-setup.mjs';

const subscription='11111111-1111-4111-8111-111111111111';
const clientId='22222222-2222-4222-8222-222222222222';
const hostId=`/subscriptions/${subscription}/resourceGroups/study/providers/Microsoft.Compute/virtualMachines/study-research`;
const outputs={researchHostResourceId:hostId,researchHostSecretReaderClientId:clientId,
  workloadTokenVaultName:'study-vault',researchServicePrivateIp:'10.48.9.4',collectorPrivateIp:'10.48.9.5',
  restrictedServicePrivateIp:'10.48.9.6'};
const env={AZURE_ENV_NAME:'research-host-test',AZURE_NAME_PREFIX:'study',THESIS_RESEARCH_CA_CERT:'C:\\outside\\ca.crt'};
const host={clientId,vaultName:'study-vault',prefix:'study',ips:['10.48.9.4','10.48.9.5','10.48.9.6']};

async function artifact(t) {
  const scratch=await mkdtemp(path.join(tmpdir(),'research-host-setup-test-'));
  t.after(()=>rm(scratch,{recursive:true,force:true}));
  return {scratch,packageBase64:Buffer.from('package').toString('base64'),
    manifestSha256:'a'.repeat(64),verifierBase64:Buffer.from('verifier').toString('base64'),verifierSha256:'b'.repeat(64)};
}

test('research host setup skips when the selected deployment has no host output',async()=>{
  let built=false;
  const code=await setupResearchHost({env,outputs:{},stdout:{write:()=>{}},stderr:{write:()=>{}},build:async()=>{built=true;}});
  assert.equal(code,0);
  assert.equal(built,false);
});

test('research host setup transfers one idempotent verified package and persists only its digest',async t=>{
  const built=await artifact(t),stateDir=await mkdtemp(path.join(tmpdir(),'research-host-state-'));
  t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const scripts=[];
  const runCommand=async scriptPath=>{scripts.push(await readFile(scriptPath,'utf8'));};
  const options={env,outputs,stdout:{write:()=>{}},stderr:{write:()=>{}},build:async()=>built,runCommand,stateDir};
  assert.equal(await setupResearchHost(options),0);
  assert.equal(scripts.length,1);
  assert.match(scripts[0],/RESEARCH_HOST_SETUP_OK/);
  assert.match(scripts[0],/node-v22\.23\.4-linux-x64\.tar\.xz/);
  assert.match(scripts[0],/mkfs\.ext4/);
  assert.match(scripts[0],/install-three-arm-service-secrets\.mjs/);
  assert.match(scripts[0],/systemctl restart nginx thesis-research thesis-collector/);
  const state=JSON.parse(await readFile(path.join(stateDir,'research-host-setup.json'),'utf8'));
  assert.equal(state.packageSha256,'a'.repeat(64));
  assert.equal(state.hostResourceId,hostId);
  assert.equal(JSON.stringify(state).includes('package'),true);
  assert.equal(await setupResearchHost({...options,runCommand:async()=>{throw new Error('must not rerun');}}),0);
  assert.equal(scripts.length,1);
});

test('research host setup fails closed while keeping remote errors bounded',async t=>{
  const built=await artifact(t),stateDir=await mkdtemp(path.join(tmpdir(),'research-host-state-fail-'));
  t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const stderr={value:'',write(value){this.value+=value;}};
  const code=await setupResearchHost({env,outputs,stdout:{write:()=>{}},stderr,build:async()=>built,
    runCommand:async()=>{throw new Error('RUN COMMAND FAILED Bearer abcdefghijklmnopqrstuvwxyz');},stateDir});
  assert.equal(code,4);
  assert.match(stderr.value,/setup failed/);
  assert.doesNotMatch(stderr.value,/abcdefghijklmnopqrstuvwxyz/);
});

test('remote setup script rejects invalid host identity inputs',()=>{
  assert.throws(()=>buildRemoteSetupScript({host:{...host,clientId:'not-a-guid'},packageBase64:'',
    manifestSha256:'a'.repeat(64),verifierBase64:'',verifierSha256:'b'.repeat(64)}),/inputs are invalid/);
  const script=buildRemoteSetupScript({host,packageBase64:'cGFja2FnZQ==',manifestSha256:'a'.repeat(64),
    verifierBase64:'dmVyaWZpZXI=',verifierSha256:'b'.repeat(64),caCertificatePath:'/opt/ca.crt'});
  assert.match(script,/HOST_CLIENT_ID='22222222-2222-4222-8222-222222222222'/);
  assert.match(script,/VAULT_URL='https:\/\/study-vault\.vault\.azure\.net\/'/);
  assert.match(script,/install-research-host-ca-key\.mjs/);
  assert.doesNotMatch(script,/PRIVATE KEY/);
});
