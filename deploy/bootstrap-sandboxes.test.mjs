import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {bootstrapSandboxImages} from './bootstrap-sandboxes.mjs';

const subscription='11111111-1111-4111-8111-111111111111';
const image=`registry.example/agent@sha256:${'a'.repeat(64)}`;
const group= `/subscriptions/${subscription}/resourceGroups/rg/providers/Microsoft.App/sandboxGroups/group-p1`;

async function fixture(t) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'sandbox-bootstrap-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const resolvedPath=path.join(dir,'deployment.resolved.json');
  const experimentConfigPath=path.join(dir,'experiment.generated.json');
  const statePath=path.join(dir,'state.json');
  await writeFile(resolvedPath,JSON.stringify({subscriptionId:subscription,location:'westus2',
    routeRegions:{azure_container_apps_sandboxes:{P1:'westus2'}},
    registry:{agentImage:image},identities:{imagePull:{resourceId:`/subscriptions/${subscription}/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/pull`,clientId:'22222222-2222-4222-8222-222222222222'}},
    fixtures:{blobEndpoint:'https://fixture.blob.core.windows.net'},sandboxGroupRuntimeSpecs:{defaultCpu:'1',defaultMemory:'2Gi',defaultDisk:'10Gi'},
    workloads:{azure_container_apps_sandboxes:{P1:{sandboxGroupId:group,workloadIdentityResourceId:`/subscriptions/${subscription}/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/workload`,
      secretReaderIdentityResourceId:`/subscriptions/${subscription}/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/secret`,clientId:'22222222-2222-4222-8222-222222222222',principalObjectId:'33333333-3333-4333-8333-333333333333'}}}}));
  const config={deployments:{azure_container_apps_sandboxes:{apiVersion:'2026-02-01-preview',timeoutMs:300000,
    imagePullIdentityResourceId:`/subscriptions/${subscription}/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/pull`,
    resources:{cpu:'1',memory:'2Gi',disk:'10Gi'},resourceUrl:'https://10.0.0.1',collectorUrl:'https://10.0.0.2:8443',restrictedUrl:'https://10.0.0.3:9443'}}};
  await writeFile(experimentConfigPath,JSON.stringify(config));
  await mkdir(path.dirname(statePath),{recursive:true});
  return {dir,resolvedPath,experimentConfigPath,statePath};
}

test('Sandbox bootstrap creates digest-pinned image, applies profile runtime/identity/egress and persists image ID',async t=>{
  const paths=await fixture(t);let createRequest,imageRequest,deleted=false;
  const client={
    createDiskImage:async(base,options)=>{imageRequest={base,options};return {diskImageId:'disk-image-1',diskImage:{id:'disk-image-1',image:{base},status:{state:'Ready'}}};},
    listDiskImages:async()=>[],
    getDiskImage:async()=>undefined,
    createSandbox:async(request)=>{createRequest=request;return {sandboxId:'smoke-1',sandbox:{state:'Running',sourcesRef:{diskImage:{id:'disk-image-1'}}}};},
    executeShellCommand:async(_id,command)=>{assert.equal(command,'node --version');return {exitCode:0,stdout:'v22.1.0\n'};},
    deleteSandbox:async()=>{deleted=true;}
  };
  const stdout={write:()=>{}},stderr={value:'',write(value){this.value+=value;}};
  const code=await bootstrapSandboxImages({env:{AZURE_ENV_NAME:'test'},resolvedPath:paths.resolvedPath,experimentConfigPath:paths.experimentConfigPath,statePath:paths.statePath,
    stdout,stderr,az:async()=>({accessToken:'token',expiresOnTimestamp:Date.now()+3600000}),clientFactory:options=>{assert.equal(options.region,'westus2');return client;}});
  assert.equal(code,0,stderr.value);
  assert.equal(imageRequest.base,image);
  assert.equal(imageRequest.options.managedIdentityClientId,'22222222-2222-4222-8222-222222222222');
  assert.equal(createRequest.sourcesRef.diskImage.id,'disk-image-1');
  assert.deepEqual(createRequest.resources,{cpu:'1000m',memory:'2Gi',disk:'10Gi'});
  assert.equal(createRequest.identitySettings,undefined);
  assert.equal(createRequest.egressPolicy,undefined);
  assert.equal(deleted,true);
  assert.deepEqual(JSON.parse(await readFile(paths.resolvedPath,'utf8')).sandboxDiskImageIds,{P1:'disk-image-1'});
  assert.deepEqual(JSON.parse(await readFile(paths.experimentConfigPath,'utf8')).deployments.azure_container_apps_sandboxes.diskImageIds,{P1:'disk-image-1'});
});

test('Sandbox bootstrap fails closed on unexpected recovered disk-image schema',async t=>{
  const paths=await fixture(t);
  await writeFile(paths.statePath,JSON.stringify({schemaVersion:1,images:{[`P1:${'a'.repeat(64)}`]:{
    imageName:`agent-p1-${'a'.repeat(16)}`,groupId:group,image,digest:'a'.repeat(64),status:'creating',diskImageId:'disk-image-1'}}}));
  const stderr={value:'',write(value){this.value+=value;}};
  const code=await bootstrapSandboxImages({env:{AZURE_ENV_NAME:'test'},resolvedPath:paths.resolvedPath,experimentConfigPath:paths.experimentConfigPath,statePath:paths.statePath,
    stdout:{write:()=>{}},stderr,az:async()=>({accessToken:'token'}),clientFactory:()=>({getDiskImage:async()=>({id:'disk-image-1',status:{state:'Ready'}})})});
  assert.equal(code,4);
  assert.match(stderr.value,/does not match the pinned image digest/);
});

test('Sandbox bootstrap reconciles an ambiguous create by listing before recreating',async t=>{
  const paths=await fixture(t);
  await writeFile(paths.statePath,JSON.stringify({schemaVersion:1,images:{[`P1:${'a'.repeat(64)}`]:{
    imageName:`agent-p1-${'a'.repeat(16)}`,groupId:group,image,digest:'a'.repeat(64),status:'creating'}}}));
  const stderr={value:'',write(value){this.value+=value;}};let listed=0,created=0,deleted=false;
  const client={listDiskImages:async()=>{listed++;return [];},
    createDiskImage:async()=>{created++;return {diskImageId:'disk-image-1',diskImage:{id:'disk-image-1',status:{state:'Ready'}}};},
    createSandbox:async()=>({sandboxId:'smoke-1',sandbox:{state:'Running'}}),
    executeShellCommand:async()=>({exitCode:0,stdout:'v22.1.0\n'}),
    deleteSandbox:async()=>{deleted=true;}};
  const code=await bootstrapSandboxImages({env:{AZURE_ENV_NAME:'test'},resolvedPath:paths.resolvedPath,experimentConfigPath:paths.experimentConfigPath,statePath:paths.statePath,
    stdout:{write:()=>{}},stderr,az:async()=>({accessToken:'token'}),clientFactory:()=>client});
  assert.equal(code,0,stderr.value);
  assert.equal(listed,1);
  assert.equal(created,1);
  assert.equal(deleted,true);
});
