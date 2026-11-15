import {pathToFileURL} from 'node:url';
import {SCENARIOS,runScenario,type Scenario} from './core.js';
import {resolveWorkloadTokenFromEnvironment,readAgentEndpoints} from './agent-config.js';
import {isCorrelatedScenario,requestIdForScenario} from './request-id.js';
export {requestIdForScenario} from './request-id.js';

export interface TrialEnvelope {
  runId:string;
  scenario:Scenario;
  u5Marker?:string;
  requestId?:string;
}

const blobScenarios=new Set<Scenario>(['U1','U2','U3','U6','U8','L1','L2']);
const safeRunId=/^[A-Za-z0-9_-]{1,150}$/;
const safeRequestId=/^[A-Za-z0-9_-]{12,100}$/;
const safeSyntheticMarker=/^SYNTHETIC-[A-Za-z0-9-]{1,100}$/;

type Env=Record<string,string|undefined>;
type BlobRunner=(input:{runId:string;scenario:Scenario;requestId?:string})=>Promise<unknown>;

/** Parse the non-secret, controller-supplied trial envelope; reject credentials and arbitrary URLs. */
export function parseTrialEnvelope(value:string|unknown):TrialEnvelope {
  let parsed:unknown=value;
  if(typeof value==='string') {
    try {parsed=JSON.parse(value);} catch {throw new Error('TRIAL_INPUT_JSON must contain valid JSON');}
  }
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)) throw new Error('trial input must be a JSON object');
  const record=parsed as Record<string,unknown>;
  const allowed=new Set(['runId','scenario','u5Marker','requestId']);
  if(Object.keys(record).some(key=>!allowed.has(key))) throw new Error('trial input contains an unsupported field');
  if(typeof record.runId!=='string'||!safeRunId.test(record.runId)) throw new Error('trial input runId is invalid');
  if(typeof record.scenario!=='string'||!SCENARIOS.includes(record.scenario as Scenario)) throw new Error('trial input scenario is invalid');
  const scenario=record.scenario as Scenario;
  if(scenario==='U5') {
    if(typeof record.u5Marker!=='string'||!safeSyntheticMarker.test(record.u5Marker))
      throw new Error('U5 requires a synthetic marker');
  } else if(record.u5Marker!==undefined) throw new Error('u5Marker is only valid for U5');
  if(record.requestId!==undefined&&(!isCorrelatedScenario(scenario)||typeof record.requestId!=='string'||!safeRequestId.test(record.requestId)))
    throw new Error('trial input requestId is invalid for this scenario');
  return {runId:record.runId,scenario,
    ...(typeof record.u5Marker==='string'?{u5Marker:record.u5Marker}:{}),
    ...(typeof record.requestId==='string'?{requestId:record.requestId}:{})};
}

/** Execute exactly one deterministic scenario; this does not start an HTTP listener. */
export async function executeSingleTrial(value:string|unknown,{env=process.env,blobRunnerFactory,workloadTokenReader,identityTokenProvider}:{env?:Env;blobRunnerFactory?:
  (options:{env:Env;blobEndpoint:string;clientId?:string;workloadToken:string;resourceUrl:string})=>Promise<BlobRunner>|BlobRunner;
  workloadTokenReader?:(uri:string,options:{clientId?:string})=>Promise<string>;
  identityTokenProvider?:()=>Promise<string>}={}) {
  const input=parseTrialEnvelope(value);
  const {resourceUrl,collectorUrl,restrictedUrl}=readAgentEndpoints(env,{requireRestricted:input.scenario==='U7'});
  const workloadToken=await resolveWorkloadTokenFromEnvironment(env,{readSecret:workloadTokenReader});
  const requestId=input.requestId??requestIdForScenario(input.runId,input.scenario);
  if(env.AZURE_BLOB_ENDPOINT&&blobScenarios.has(input.scenario)) {
    let runBlobScenario:BlobRunner;
    if(blobRunnerFactory) {
      runBlobScenario=await blobRunnerFactory({env,blobEndpoint:env.AZURE_BLOB_ENDPOINT,
        clientId:env.AZURE_CLIENT_ID,workloadToken,resourceUrl});
    } else {
      const {createBlobWorkload}=await import('./azure-blob-workload.mjs');
      const {createManagedStorageTokenProvider}=await import('./azure-managed-token.mjs');
      const getToken=createManagedStorageTokenProvider({clientId:env.AZURE_CLIENT_ID||undefined});
      runBlobScenario=createBlobWorkload({blobEndpoint:env.AZURE_BLOB_ENDPOINT,getToken,
        blobResourceId:env.THESIS_BLOB_RESOURCE_ID,expectedPrincipalId:env.AZURE_PRINCIPAL_OBJECT_ID,
        expectedClientId:env.AZURE_CLIENT_ID,dummyApiUrl:resourceUrl,dummyApiWorkloadToken:workloadToken});
    }
    return await runBlobScenario({runId:input.runId,scenario:input.scenario,...(requestId?{requestId}:{})});
  }
  const output=await runScenario({runId:input.runId,scenario:input.scenario,
    ...(input.u5Marker?{u5Marker:input.u5Marker}:{}),...(requestId?{requestId}:{})},
    {workloadToken,resourceUrl,collectorUrl,restrictedUrl});
  if(input.runId.startsWith('pilot-')&&['U5','U7'].includes(input.scenario)) {
    const expectedPrincipalId=env.AZURE_PRINCIPAL_OBJECT_ID,expectedClientId=env.AZURE_CLIENT_ID;
    if(typeof expectedClientId==='string') {
      const {createManagedStorageTokenProvider}=await import('./azure-managed-token.mjs');
      const {managedIdentityClaims}=await import('./azure-blob-workload.mjs');
      const getIdentityToken=identityTokenProvider??createManagedStorageTokenProvider({clientId:expectedClientId});
      const identity=managedIdentityClaims(await getIdentityToken(),{expectedPrincipalId,expectedClientId});
      return {...output,workloadIdentity:{objectId:identity.objectId,clientId:identity.clientId}};
    }
  }
  return output;
}

export async function main({env=process.env,stdout=process.stdout,stderr=process.stderr}:
  {env?:Env;stdout?:{write(value:string):unknown};stderr?:{write(value:string):unknown}}={}) {
  try {
    if(typeof env.TRIAL_INPUT_JSON!=='string') throw new Error('TRIAL_INPUT_JSON is required');
    const output=await executeSingleTrial(env.TRIAL_INPUT_JSON,{env});
    stdout.write(`${JSON.stringify(output)}\n`);
    return 0;
  } catch(error) {
    stderr.write(`${JSON.stringify({errorType:error instanceof Error?error.name:'Error'})}\n`);
    return 1;
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) process.exitCode=await main();
