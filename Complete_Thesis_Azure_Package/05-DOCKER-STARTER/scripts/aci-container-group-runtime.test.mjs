import test from 'node:test';
import assert from 'node:assert/strict';
import {aciGroupName,buildAciContainerGroupBody,createAciContainerGroupClient,createAciTrialAdapter} from './aci-container-group-runtime.mjs';

const pullId='/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/pull';
const workloadId='/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/workload';
const subnetId='/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/vnet/subnets/aci-experiment';
const config={location:'eastus',imageDigestReference:`thesisacr.azurecr.io/thesis-agent@sha256:${'a'.repeat(64)}`,registryServer:'thesisacr.azurecr.io',
  pullIdentityId:pullId,workloadIdentityId:workloadId,workloadIdentityClientId:'11111111-1111-4111-8111-111111111111',subnetId,
  researchUrl:'https://10.48.9.4',collectorUrl:'https://10.48.9.5:8443',blobEndpoint:'https://fixture.blob.core.windows.net',
  workloadToken:'workload-secret-0123456789',trialRequestKey:'controller-secret-0123456789'};

test('ACI groups are deterministic one-run names and refuse invalid route or run identifiers',()=>{
  const name=aciGroupName('pilot-u1-01','P1');
  assert.equal(name,aciGroupName('pilot-u1-01','P1'));
  assert.match(name,/^thesis-aci-p1-[a-f0-9]{24}$/);
  assert.throws(()=>aciGroupName('pilot/unsafe','P1'),/invalid ACI run identity/);
  assert.throws(()=>aciGroupName('pilot-u1-01','P3'),/invalid ACI run identity/);
});

test('ACI spec pins image, keeps pull/workload identities separate, and marks credentials secure',()=>{
  const body=buildAciContainerGroupBody(config);
  assert.equal(body.properties.restartPolicy,'Never');
  assert.equal(body.identity.type,'UserAssigned');
  assert.ok(body.identity.userAssignedIdentities[pullId]);
  assert.ok(body.identity.userAssignedIdentities[workloadId]);
  assert.equal(body.properties.imageRegistryCredentials[0].identity,pullId);
  assert.equal(body.properties.containers[0].properties.image,config.imageDigestReference);
  const env=body.properties.containers[0].properties.environmentVariables;
  assert.equal(env.find(item=>item.name==='WORKLOAD_TOKEN').secureValue,config.workloadToken);
  assert.equal(env.find(item=>item.name==='TRIAL_REQUEST_KEY').secureValue,config.trialRequestKey);
  assert.equal(env.find(item=>item.name==='WORKLOAD_TOKEN').value,undefined);
  assert.equal(body.properties.ipAddress.type,'Private');
  assert.equal(body.properties.subnetIds[0].id,subnetId);
});

test('ACI spec refuses a mutable image tag, identity reuse, and invalid secrets',()=>{
  assert.throws(()=>buildAciContainerGroupBody({...config,imageDigestReference:'thesisacr.azurecr.io/thesis-agent:latest'}),/pinned by digest/);
  assert.throws(()=>buildAciContainerGroupBody({...config,workloadIdentityId:pullId}),/must be distinct/);
  assert.throws(()=>buildAciContainerGroupBody({...config,trialRequestKey:'short'}),/missing ACI/);
});

test('ARM group create refuses an existing deterministic group and waits for private Running allocation',async()=>{
  const calls=[];
  const name=aciGroupName('pilot-u1-01','P1');
  let exists=false;
  const fetchImpl=async(url,options)=>{
    calls.push({url,method:options.method});
    if(options.method==='GET' && !exists) return new Response('{}',{status:404});
    if(options.method==='PUT') {exists=true;return new Response('{}',{status:202});}
    if(options.method==='GET') return new Response(JSON.stringify({id:'group-id',properties:{provisioningState:'Succeeded',ipAddress:{ip:'10.48.13.7'}}}),{status:200});
    return new Response('{}',{status:500});
  };
  const client=createAciContainerGroupClient({subscriptionId:'11111111-1111-4111-8111-111111111111',resourceGroup:'rg-test',getManagementToken:async()=> 'arm-token',fetchImpl,pollIntervalMs:10,createTimeoutMs:100,sleep:async()=>{}});
  const group=await client.create(name,{location:'eastus'});
  assert.deepEqual(group,{name,resourceId:'group-id',privateIp:'10.48.13.7',provisioningState:'Succeeded'});
  await assert.rejects(client.create(name,{location:'eastus'}),/already exists; refusing replay/);
  assert.equal(calls.filter(call=>call.method==='PUT').length,1);
});

test('ACI cleanup waits until ARM confirms the deterministic group is absent',async()=>{
  const calls=[];
  const name=aciGroupName('pilot-u1-02','P2');
  let exists=true;
  const fetchImpl=async(url,options)=>{
    calls.push(options.method);
    if(options.method==='GET' && exists) return new Response(JSON.stringify({properties:{provisioningState:'Succeeded'}}),{status:200});
    if(options.method==='DELETE') {exists=false;return new Response(null,{status:204});}
    return new Response('{}',{status:404});
  };
  const client=createAciContainerGroupClient({subscriptionId:'11111111-1111-4111-8111-111111111111',resourceGroup:'rg-test',getManagementToken:async()=> 'arm-token',fetchImpl,pollIntervalMs:10,deleteTimeoutMs:100,sleep:async()=>{}});
  assert.deepEqual(await client.delete(name),{name,deleted:true,alreadyAbsent:false});
  assert.deepEqual(calls,['GET','DELETE','GET']);
});

test('ACI adapter creates one group, health-checks, sends exactly one matching task and confirms cleanup',async()=>{
  const events=[],reset={u5Marker:'U5-marker'};
  const fixtureAdapter={reset:async trial=>{events.push(`reset:${trial.runId}`);return reset;},collect:async()=>({proof:'independent'})};
  const groupClient={create:async name=>{events.push(`create:${name}`);return {name,privateIp:'10.48.13.9',provisioningState:'Succeeded'};},delete:async name=>{events.push(`delete:${name}`);return {name,deleted:true,alreadyAbsent:false};}};
  const fetchImpl=async(url,options)=>{
    events.push(`${options.method}:${new URL(url).pathname}`);
    if(url.endsWith('/health')) return new Response(JSON.stringify({ready:true}),{status:200});
    assert.equal(options.headers['x-trial-key'],config.trialRequestKey);
    assert.deepEqual(JSON.parse(options.body),{runId:'pilot-u5-1',scenario:'U5',u5Marker:'U5-marker'});
    return new Response(JSON.stringify({runId:'pilot-u5-1',scenario:'U5',transportOk:true}),{status:200});
  };
  const adapter=createAciTrialAdapter({fixtureAdapter,groupClient,groupBodyForTrial:async()=>({safe:true}),controllerToken:config.trialRequestKey,fetchImpl,readinessTimeoutMs:1000,pollIntervalMs:100});
  const trial={runId:'pilot-u5-1',profile:'P1',scenario:'U5'};
  const fixture=await adapter.reset(trial);
  const output=await adapter.execute(trial,fixture);
  assert.equal(output.runId,trial.runId);
  assert.equal(output.aciPrivateIp,'10.48.13.9');
  assert.deepEqual(await adapter.collect(trial,fixture,output),{proof:'independent'});
  assert.equal((await adapter.cleanup(trial)).deleted,true);
  await assert.rejects(adapter.execute(trial,fixture),/already claimed/);
  assert.ok(events.some(event=>event.startsWith('create:thesis-aci-p1-')));
  assert.ok(events.some(event=>event.startsWith('delete:thesis-aci-p1-')));
});

test('ACI adapter refuses public addresses and unconfirmed cleanup',async()=>{
  const fixtureAdapter={reset:async()=>({}),collect:async()=>({})};
  const groupClient={create:async name=>({name,privateIp:'8.8.8.8',provisioningState:'Succeeded'}),delete:async()=>({deleted:false})};
  const adapter=createAciTrialAdapter({fixtureAdapter,groupClient,groupBodyForTrial:async()=>({}),controllerToken:'controller-secret-0123456789',fetchImpl:async()=>new Response('{}',{status:200})});
  await assert.rejects(adapter.execute({runId:'pilot-u1-1',profile:'P1',scenario:'U1'},{}),/invalid private endpoint/);
});

test('ACI adapter refuses U6 and U8 before allocating groups until cross-group analogues are validated',async()=>{
  const created=[];
  const resets=[];
  const fixtureAdapter={reset:async trial=>{resets.push(trial.runId);return {};},collect:async()=>({})};
  const groupClient={create:async name=>{created.push(name);return {name,privateIp:'10.48.13.9',provisioningState:'Succeeded'};},delete:async()=>({deleted:true})};
  const adapter=createAciTrialAdapter({fixtureAdapter,groupClient,groupBodyForTrial:async()=>({}),controllerToken:'controller-secret-0123456789',
    fetchImpl:async()=>new Response('{"ready":true}',{status:200})});
  for(const scenario of ['U6','U8'])
    await assert.rejects(adapter.reset({runId:`pilot-${scenario.toLowerCase()}-reset`,profile:'P1',scenario}),new RegExp(`ACI ${scenario} cross-group lifecycle analogue is not implemented`));
  for(const scenario of ['U6','U8'])
    await assert.rejects(adapter.execute({runId:`pilot-${scenario.toLowerCase()}-1`,profile:'P1',scenario},{}),new RegExp(`ACI ${scenario} cross-group lifecycle analogue is not implemented`));
  assert.deepEqual(created,[]);
  assert.deepEqual(resets,[]);
});
