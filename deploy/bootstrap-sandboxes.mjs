#!/usr/bin/env node
/** Provision digest-pinned ACA Sandbox disk images and verify per-profile runtime policy. */
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {readAzdEnv, makeAzRunner, makeStepLogger} from './common.mjs';

const PROFILE_KEYS=['P1','P2','P3'];
const DATA_PLANE_SCOPE='https://dynamicsessions.io/.default';
const DATA_PLANE_RESOURCE='https://dynamicsessions.io';

function diskImageResource(value) {
  return typeof value==='string' && value.length>0 && value.length<=2048 &&
    value.split('/').every(segment=>/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)&&!segment.includes('..'));
}
function groupLocation(resourceId) {
  const match=/^\/subscriptions\/([0-9a-f-]{36})\/resourceGroups\/([A-Za-z0-9._()-]+)\/providers\/Microsoft\.App\/sandboxGroups\/([A-Za-z0-9._-]+)$/i.exec(resourceId??'');
  return match?{subscriptionId:match[1],resourceGroup:match[2],sandboxGroup:match[3]}:undefined;
}
function digestFromImage(image) {
  const match=/@sha256:([a-f0-9]{64})$/i.exec(image??'');
  return match?.[1]?.toLowerCase();
}
function makeImageName(profile,digest) { return `agent-${profile.toLowerCase()}-${digest.slice(0,16)}`; }
function endpointTarget(value,label) {
  let url;
  try {url=new URL(value);} catch {throw new Error(`Sandbox ${label} endpoint is missing or invalid`);}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)
    throw new Error(`Sandbox ${label} endpoint is not a clean HTTPS URL`);
  return {host:url.hostname,scheme:'https'};
}
function egressPolicyFor({deployment,profile,blobEndpoint}) {
  const rules=[
    {name:'allow-research-fixture',match:endpointTarget(deployment.resourceUrl,'research'),action:{type:'Allow'}},
    {name:'allow-fixture-blob-store',match:endpointTarget(blobEndpoint,'Blob fixture'),action:{type:'Allow'}}
  ];
  if(profile!=='P3') {
    rules.push({name:'allow-collector-service',match:endpointTarget(deployment.collectorUrl,'collector'),action:{type:'Allow'}});
    if(deployment.restrictedUrl) rules.push({name:'allow-restricted-service',match:endpointTarget(deployment.restrictedUrl,'restricted'),action:{type:'Allow'}});
  }
  return {defaultAction:'Deny',trafficInspection:'Full',rules};
}
function identitySettingsFor(route,deployment) {
  if(!route.workloadIdentityResourceId||!route.secretReaderIdentityResourceId||!deployment.imagePullIdentityResourceId)
    throw new Error('Sandbox profile is missing one of its workload, secret-reader, or image-pull identities');
  return [
    {identity:route.workloadIdentityResourceId,lifecycle:'main'},
    {identity:route.secretReaderIdentityResourceId,lifecycle:'main'},
    {identity:deployment.imagePullIdentityResourceId,lifecycle:'none'}
  ];
}

export async function bootstrapSandboxImages({env=process.env,az=makeAzRunner(),stdout=process.stdout,stderr=process.stderr,
  resolvedPath,experimentConfigPath,statePath,clientFactory,now=()=>Date.now()}={}) {
  const log=makeStepLogger({stream:stdout});
  const envName=env.AZURE_ENV_NAME??'default';
  const root=process.cwd();
  const resolvedFile=resolvedPath??path.join(root,'.azure',envName,'deployment.resolved.json');
  const configFile=experimentConfigPath??path.join(root,'Complete_Thesis_Azure_Package','05-DOCKER-STARTER','config','experiment.generated.json');
  const stateFile=statePath??path.join(root,'.azure',envName,'sandbox-bootstrap.json');
  let resolved,config,state;
  try {
    resolved=JSON.parse(await readFile(resolvedFile,'utf8'));
    config=JSON.parse(await readFile(configFile,'utf8'));
  } catch(error) {
    if(error?.code==='ENOENT') {
      stderr.write('sandbox bootstrap: resolved deployment or generated experiment config is missing; run configure first\n');
      return 5;
    } else {
      stderr.write('sandbox bootstrap: deployment inputs or bootstrap state are invalid\n');
      return 5;
    }
  }
  try { state=JSON.parse(await readFile(stateFile,'utf8')); }
  catch(error) {
    if(error?.code==='ENOENT') state={schemaVersion:1,images:{}};
    else {
      stderr.write('sandbox bootstrap: deployment inputs or bootstrap state are invalid\n');
      return 5;
    }
  }
  if(state?.schemaVersion!==1||typeof state.images!=='object'||state.images===null||Array.isArray(state.images)) {
    stderr.write('sandbox bootstrap: deployment inputs or bootstrap state are invalid\n');
    return 5;
  }
  const routes=resolved.workloads?.azure_container_apps_sandboxes??{};
  if(!Object.values(routes).some(Boolean)) {
    log('sandbox-bootstrap','skipped',{note:'no deployed ACA Sandbox routes'});
    return 0;
  }
  const image=resolved.registry?.agentImage,digest=digestFromImage(image);
  if(!digest||!resolved.subscriptionId||!resolved.identities?.imagePull?.resourceId||!resolved.fixtures?.blobEndpoint) {
    stderr.write('sandbox bootstrap: pinned image, subscription, image-pull identity, or fixture endpoint is missing\n');
    return 5;
  }
  const deployment=config.deployments?.azure_container_apps_sandboxes;
  if(!deployment) {
    stderr.write('sandbox bootstrap: generated ACA Sandbox deployment is missing\n');
    return 5;
  }
  let token,tokenExpiry=0;
  const getToken=async scope=>{
    if(scope!==DATA_PLANE_SCOPE) throw new Error('Sandbox bootstrap requested an unexpected token scope');
    if(token&&tokenExpiry>now()+120000) return token;
    try {
      const result=await az(['account','get-access-token','--subscription',resolved.subscriptionId,'--resource',DATA_PLANE_RESOURCE]);
      if(typeof result?.accessToken!=='string'||!result.accessToken||/\r|\n/.test(result.accessToken)) throw new Error();
      token=result.accessToken;
      tokenExpiry=Number.isFinite(result.expiresOnTimestamp)?result.expiresOnTimestamp:now()+45*60*1000;
      return token;
    } catch {throw new Error('Azure CLI could not acquire the ACA Sandbox data-plane token');}
  };
  const {createAcaSandboxDataPlaneClient}=await import(pathToFileURL(path.join(root,'Complete_Thesis_Azure_Package','05-DOCKER-STARTER','scripts','aca-sandbox-data-plane.mjs')).href);
  const createClient=clientFactory??(options=>createAcaSandboxDataPlaneClient(options));
  const resultIds={};
  try {
    for(const profile of PROFILE_KEYS) {
      const route=routes[profile];
      if(!route) continue;
      const location=groupLocation(route.sandboxGroupId);
      const region=resolved.routeRegions?.azure_container_apps_sandboxes?.[profile]??resolved.location;
      if(!location||location.subscriptionId.toLowerCase()!==resolved.subscriptionId.toLowerCase()||typeof region!=='string')
        throw new Error(`Sandbox ${profile} route has invalid group or region metadata`);
      const imageName=makeImageName(profile,digest);
      const client=createClient({region,subscriptionId:location.subscriptionId,resourceGroup:location.resourceGroup,
        sandboxGroup:location.sandboxGroup,getToken,apiVersion:deployment.apiVersion});
      const stateKey=`${profile}:${digest}`;
      let imageRecord=state.images?.[stateKey];
      if(imageRecord&&(imageRecord.imageName!==imageName||imageRecord.groupId!==route.sandboxGroupId))
        throw new Error(`Sandbox ${profile} bootstrap state conflicts with the resolved deployment`);
      if(imageRecord?.status==='creating'&&!imageRecord.diskImageId) {
        throw new Error(`Sandbox ${profile} image creation outcome is ambiguous; reconcile disk image ${imageName} before retrying`);
      }
      if(!imageRecord?.diskImageId) {
        state.images??={};
        imageRecord={imageName,groupId:route.sandboxGroupId,image,digest,status:'creating',startedAt:new Date(now()).toISOString()};
        state.images[stateKey]=imageRecord;
        await writeState(stateFile,state);
        const created=await client.createDiskImage(image,{name:imageName,managedIdentityResourceId:resolved.identities.imagePull.resourceId,
          timeoutMs:deployment.timeoutMs??300000});
        if(!diskImageResource(created?.diskImageId)) throw new Error(`Sandbox ${profile} returned an invalid disk image ID`);
        imageRecord={...imageRecord,diskImageId:created.diskImageId,status:'ready',readyAt:new Date(now()).toISOString()};
        state.images[stateKey]=imageRecord;
        await writeState(stateFile,state);
      } else {
        const found=await client.getDiskImage(imageRecord.diskImageId);
        const base=found?.image?.base??found?.properties?.image?.base;
        const status=String(found?.status?.state??'').toLowerCase();
        if(!found||base!==image||!['ready','succeeded'].includes(status))
          throw new Error(`Sandbox ${profile} disk image is not ready or does not match the pinned image digest`);
      }
      if(!diskImageResource(imageRecord.diskImageId)) throw new Error(`Sandbox ${profile} bootstrap state has an invalid disk image ID`);
      resultIds[profile]=imageRecord.diskImageId;
      const smoke=await runProfileSmoke({client,route,deployment,profile,diskImageId:imageRecord.diskImageId,
        resolved,config,timeoutMs:Math.min(deployment.timeoutMs??300000,60000)});
      log('sandbox-bootstrap','profile-ready',{note:`${profile} ${region}; image ${imageRecord.diskImageId}; smoke ${smoke}`});
    }
  } catch(error) {
    const message=String(error?.message??error).replace(/Bearer\s+\S+/gi,'Bearer [redacted]').slice(0,240);
    stderr.write(`sandbox bootstrap failed: ${message}\n`);
    return 4;
  }
  resolved.sandboxDiskImageIds={...(resolved.sandboxDiskImageIds??{}),...resultIds};
  config.deployments.azure_container_apps_sandboxes.diskImageIds={
    ...(config.deployments.azure_container_apps_sandboxes.diskImageIds??{}),...resultIds};
  await writeFile(resolvedFile,`${JSON.stringify(resolved,null,2)}\n`);
  await writeFile(configFile,`${JSON.stringify(config,null,2)}\n`);
  log('sandbox-bootstrap','complete',{note:`${Object.keys(resultIds).length} disk image(s), runtime and per-sandbox policy smoke passed`});
  return 0;
}

async function runProfileSmoke({client,route,deployment,profile,diskImageId,resolved,config,timeoutMs}) {
  const runtime=resolved.sandboxGroupRuntimeSpecs??{};
  const resources={cpu:runtime.defaultCpu??deployment.resources?.cpu,memory:runtime.defaultMemory??deployment.resources?.memory,
    disk:runtime.defaultDisk??deployment.resources?.disk};
  if(!resources.cpu||!resources.memory||!resources.disk) throw new Error(`Sandbox ${profile} runtime sizing is incomplete`);
  const env={TRIAL_REQUEST_KEY:'sandbox-bootstrap-non-counted',RESEARCH_URL:deployment.resourceUrl,
    COLLECTOR_URL:deployment.collectorUrl,AZURE_BLOB_ENDPOINT:resolved.fixtures.blobEndpoint,
    AZURE_CLIENT_ID:route.clientId,AZURE_PRINCIPAL_OBJECT_ID:route.principalObjectId,
    THESIS_BLOB_RESOURCE_ID:resolved.fixtures.blobResourceId??'',
    THESIS_WORKLOAD_TOKEN_SECRET_URI:route.workloadTokenSecretUri??'',
    THESIS_SECRET_READER_CLIENT_ID:route.secretReaderClientId??''};
  if(deployment.restrictedUrl) env.RESTRICTED_URL=deployment.restrictedUrl;
  const requestBody={sourcesRef:{diskImage:{id:diskImageId}},resources,
    lifecycle:{autoSuspendPolicy:{enabled:true,interval:300,mode:'Memory'}},
    identitySettings:identitySettingsFor(route,deployment),
    egressPolicy:egressPolicyFor({deployment,profile,blobEndpoint:resolved.fixtures.blobEndpoint}),environment:Object.entries(env).map(([name,value])=>({name,value}))};
  let sandbox;
  try {
    sandbox=await client.createSandbox(requestBody,{timeoutMs});
    const result=await client.executeShellCommand(sandbox.sandboxId,'node --version');
    if(result?.exitCode!==0||typeof result.stdout!=='string'||!/^v\d+\.\d+\.\d+/.test(result.stdout.trim()))
      throw new Error('Sandbox runtime smoke did not return a Node version');
    const sandboxDescription=sandbox.sandbox;
    if(sandboxDescription?.sourcesRef?.diskImage?.id&&sandboxDescription.sourcesRef.diskImage.id!==diskImageId)
      throw new Error('Sandbox smoke used a different disk image than the configured profile image');
    return result.stdout.trim();
  } finally {
    if(sandbox?.sandboxId) await client.deleteSandbox(sandbox.sandboxId,{timeoutMs});
  }
}

async function writeState(file,state) {
  await mkdir(path.dirname(file),{recursive:true});
  await writeFile(file,`${JSON.stringify(state,null,2)}\n`);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  process.exitCode=await bootstrapSandboxImages();
