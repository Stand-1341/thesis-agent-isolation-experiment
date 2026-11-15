#!/usr/bin/env node
/** Build, publish and verify identical Functions Flex packages without exposing secrets. */
import {mkdtemp,readFile,readdir,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {execCommand,makeAzRunner,makeStepLogger,readAzdEnv,readInfraOutputs} from './common.mjs';

const STARTER=path.resolve('Complete_Thesis_Azure_Package/05-DOCKER-STARTER');
const EXPECTED_TRIGGERS=new Set(['thesisNetworkProbe','thesisSessionSeed','thesisRun']);
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function parseFunctionResource(resourceId) {
  const match=/^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Web\/sites\/([^/]+)$/i.exec(resourceId??'');
  return match?{subscriptionId:match[1],resourceGroup:match[2],name:match[3]}:undefined;
}

export async function buildFunctionsPackage({env,exec=execCommand,work=mkdtemp(path.join(tmpdir(),'thesis-functions-'))}={}) {
  const scratch=await work;
  const packageDir=path.join(scratch,'package');
  const zip=path.join(scratch,'functions.zip');
  try {
    await exec(['powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(STARTER,'scripts','build-flex-package.ps1'),
      '-OutputDirectory',packageDir,'-CaCertificatePath',env.THESIS_RESEARCH_CA_CERT],{timeoutMs:20*60*1000});
    const entries=await readdir(packageDir);
    const required=['host.json','index.mjs','prepare-run-request.mjs','package.json','package-lock.json','dist','certs','node_modules'];
    for(const name of required) if(!entries.includes(name)) throw new Error(`Functions package is missing ${name}`);
    if(entries.some(name=>/^(?:local\.settings\.json|\.env|results|\.git|\.azure)$/i.test(name))) throw new Error('Functions package contains forbidden local state');
    await exec(['tar.exe','-a','-c','-f',zip,...entries],{cwd:packageDir,timeoutMs:120000});
    const bytes=await readFile(zip);
    return {scratch,zip,packageSha256:sha256(bytes)};
  } catch(error) {
    await rm(scratch,{recursive:true,force:true}).catch(()=>{});
    throw error;
  }
}

async function readAndStoreFunctionKey({az,vaultName,location,profile,fetchImpl=fetch}) {
  if(!/^p[123]$/i.test(profile)) throw new Error('invalid Functions route profile');
  const keys=await az(['functionapp','function','keys','list','--subscription',location.subscriptionId,
    '--resource-group',location.resourceGroup,'--name',location.name,'--function-name','thesisRun'])
    .catch(()=>undefined);
  const value=keys?.default;
  if(typeof value!=='string'||value.length<16||/[\r\n]/.test(value)) return false;
  const tokenResult=await az(['account','get-access-token','--subscription',location.subscriptionId,'--resource','https://vault.azure.net']);
  if(typeof tokenResult?.accessToken!=='string'||!tokenResult.accessToken||/[\r\n]/.test(tokenResult.accessToken))
    throw new Error('vault token unavailable');
  const secretName=`functions-${profile.toLowerCase()}-function-key`;
  const response=await fetchImpl(`https://${vaultName}.vault.azure.net/secrets/${encodeURIComponent(secretName)}?api-version=7.4`,{
    method:'PUT',redirect:'error',signal:AbortSignal.timeout(30000),
    headers:{authorization:`Bearer ${tokenResult.accessToken}`,'content-type':'application/json'},body:JSON.stringify({value})
  });
  if(!response.ok) throw new Error(`could not store ${secretName} (HTTP ${response.status})`);
  return true;
}

export async function publishFunctions({env=process.env,az=makeAzRunner(),stdout=process.stdout,stderr=process.stderr,
  exec=execCommand,outputs,build=buildFunctionsPackage,sleepImpl=sleep,fetchImpl=fetch,stateDir}={}) {
  const log=makeStepLogger({stream:stdout});
  const values=await readAzdEnv(env);
  const armOutputs=outputs??await readInfraOutputs().catch(()=>undefined);
  const routes=armOutputs?.experimentConfigRoutes?.azure_functions_flex;
  if(!routes) {log('functions-publish','skipped',{note:'no Functions Flex routes in selected deployment'});return 0;}
  if(!values.AGENT_IMAGE_DIGEST) {stderr.write('functions publish: pinned agent digest is missing\n');return 5;}
  if(!values.THESIS_RESEARCH_CA_CERT) {stderr.write('functions publish: external CA certificate path is missing\n');return 5;}
  const vaultName=armOutputs.workloadTokenVaultName??values.WORKLOAD_TOKEN_VAULT_NAME;
  if(!vaultName) {stderr.write('functions publish: Key Vault name is unresolved\n');return 5;}
  const stateDirectory=stateDir??path.join(process.cwd(),'.azure',values.AZURE_ENV_NAME??'default');
  const statePath=path.join(stateDirectory,'functions-publish.json');
  let state={schemaVersion:1,packages:{}};
  try {state=JSON.parse(await readFile(statePath,'utf8'));} catch {}
  let artifact;
  try {artifact=await build({env:values,exec});}
  catch(error) {stderr.write(`functions publish: package build failed: ${String(error?.message??error).slice(0,300)}\n`);return 4;}
  const previous=state.packages?.[artifact.packageSha256]??{routes:{}};
  const current={packageSha256:artifact.packageSha256,routes:{...(previous.routes??{})}};
  let exitCode=0;
  try {
    await mkdir(stateDirectory,{recursive:true});
    for(const [profile,route] of Object.entries(routes)) {
      const location=parseFunctionResource(route?.resourceId);
      if(!location) {stderr.write(`functions publish: ${profile} has no valid Function app resource ID\n`);exitCode=4;continue;}
      if(current.routes[profile]?.resourceId!==route.resourceId) {
        const published=await az(['functionapp','deployment','source','config-zip','--subscription',location.subscriptionId,
          '--resource-group',location.resourceGroup,'--name',location.name,'--src',artifact.zip],{json:false})
          .then(()=>true).catch(()=>false);
        if(!published) {stderr.write(`functions publish: ZIP deployment failed for ${profile}; check SCM access and app state\n`);exitCode=4;continue;}
        current.routes[profile]={resourceId:route.resourceId,publishedAt:new Date().toISOString()};
      }
      let verified=false;
      for(let attempt=0;attempt<12&&!verified;attempt++) {
        const functions=await az(['functionapp','function','list','--subscription',location.subscriptionId,
          '--resource-group',location.resourceGroup,'--name',location.name],{json:true}).catch(()=>undefined);
        const names=new Set((functions??[]).map(item=>item.name?.split('/').at(-1)));
        verified=[...EXPECTED_TRIGGERS].every(name=>names.has(name));
        if(!verified) await sleepImpl(5000);
      }
      if(!verified) {stderr.write(`functions publish: expected triggers did not index for ${profile}\n`);exitCode=4;continue;}
      const keyStored=await readAndStoreFunctionKey({az,vaultName,location,profile,fetchImpl}).catch(error=>{
        stderr.write(`functions publish: Function key bootstrap failed for ${profile}: ${String(error?.message??error).slice(0,160)}\n`);return false;
      });
      if(!keyStored) {stderr.write(`functions publish: thesisRun key was unavailable or could not be secured for ${profile}\n`);exitCode=4;continue;}
      current.routes[profile].verifiedAt=new Date().toISOString();
      log('functions-publish','route-ready',{note:`${profile}; ${location.name}; package ${artifact.packageSha256.slice(0,16)}…`});
    }
    state.packages={[artifact.packageSha256]:current};
    await writeFile(statePath,`${JSON.stringify({schemaVersion:1,...state},null,2)}\n`);
  } finally {await rm(artifact.scratch,{recursive:true,force:true}).catch(()=>{});}
  return exitCode;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  process.exitCode=await publishFunctions();
