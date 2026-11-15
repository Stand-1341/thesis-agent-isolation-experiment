import { app } from '@azure/functions';
import { readFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { SCENARIOS, runScenario } from './dist/core.js';
import { probeNetwork } from './dist/network-probe.mjs';
import { prepareRunRequest } from './prepare-run-request.mjs';

const blobScenarios=new Set(['U1','U2','U3','U6','U8','L1','L2']);
const authMode=process.env.AZURE_TOKEN_MODE || 'managed';
for(const name of ['WORKLOAD_TOKEN','TRIAL_REQUEST_KEY']) {
  const value=process.env[name];
  if(typeof value==='string' && /^@Microsoft\.KeyVault\(/i.test(value))
    throw new Error(`${name} Key Vault reference was not resolved`);
}
async function tlsTrustStatus() {
  if(!process.env.NODE_EXTRA_CA_CERTS) return {configured:false,certificateReadable:false};
  try {
    const certificate=new X509Certificate(await readFile(process.env.NODE_EXTRA_CA_CERTS));
    return {configured:true,certificateReadable:true,isCertificateAuthority:certificate.ca,
      fingerprint256:certificate.fingerprint256};
  } catch { return {configured:true,certificateReadable:false}; }
}
if(!['managed','delegated'].includes(authMode) || (authMode==='delegated' && (!process.env.AZURE_BLOB_ENDPOINT || !!process.env.WORKLOAD_TOKEN || !!process.env.AZURE_CLIENT_ID))) throw new Error('invalid Azure token mode');
let blobRunner,delegatedFactory,managedGetBlobToken;
if(process.env.AZURE_BLOB_ENDPOINT) {
  const endpoint=process.env.AZURE_BLOB_ENDPOINT;
  const {createBlobWorkload}=await import('./dist/azure-blob-workload.mjs');
  if(authMode==='managed') {
    const {createManagedStorageTokenProvider}=await import('./dist/azure-managed-token.mjs');
    managedGetBlobToken=createManagedStorageTokenProvider({clientId:process.env.AZURE_CLIENT_ID || undefined});
    blobRunner=createBlobWorkload({blobEndpoint:endpoint,getToken:managedGetBlobToken,
      blobResourceId:process.env.THESIS_BLOB_RESOURCE_ID,expectedPrincipalId:process.env.AZURE_PRINCIPAL_OBJECT_ID,
      expectedClientId:process.env.AZURE_CLIENT_ID,dummyApiUrl:process.env.RESEARCH_URL,dummyApiWorkloadToken:process.env.WORKLOAD_TOKEN});
  } else {
    const {createDelegatedStorageTokenProvider}=await import('./dist/azure-delegated-token.mjs');
    delegatedFactory=data=>{
      if(typeof data.azureAccessToken!=='string' || typeof data.expectedPrincipalId!=='string' || typeof data.mockWorkloadToken!=='string') throw new Error('missing delegated workload credentials');
      return createBlobWorkload({blobEndpoint:endpoint,getToken:createDelegatedStorageTokenProvider({token:data.azureAccessToken,expectedPrincipalId:data.expectedPrincipalId}),
        dummyApiUrl:process.env.RESEARCH_URL,dummyApiWorkloadToken:data.mockWorkloadToken});
    };
  }
}

app.http('thesisNetworkProbe', {
  methods:['POST'], route:'network-probe', authLevel:'function',
  handler:async(request)=>{
    if(!process.env.TRIAL_REQUEST_KEY || request.headers.get('x-trial-key')!==process.env.TRIAL_REQUEST_KEY)
      return {status:403,jsonBody:{error:'controller authorization required'}};
    if(!process.env.RESEARCH_URL || !process.env.COLLECTOR_URL)
      return {status:500,jsonBody:{error:'probe endpoints not configured'}};
    const result=await probeNetwork(`${process.env.RESEARCH_URL}/health`,`${process.env.COLLECTOR_URL}/health`,{restrictedIp:process.env.PROBE_RESTRICTED_IP,redirectUrl:process.env.PROBE_REDIRECT_URL});
    return {status:200,jsonBody:{...result,nodeTlsTrust:await tlsTrustStatus()}};
  }
});

app.http('thesisSessionSeed', {
  methods:['POST'], route:'session-seed', authLevel:'function',
  handler:async(request)=>{
    if(!process.env.TRIAL_REQUEST_KEY || request.headers.get('x-trial-key')!==process.env.TRIAL_REQUEST_KEY)
      return {status:403,jsonBody:{error:'controller authorization required'}};
    try {
      const body=await request.json();
      if(authMode!=='delegated' || !process.env.AZURE_BLOB_ENDPOINT || !body || typeof body!=='object' ||
        typeof body.runId!=='string' || typeof body.kind!=='string' || typeof body.marker!=='string' ||
        typeof body.azureAccessToken!=='string' || typeof body.expectedPrincipalId!=='string') throw new Error('invalid session seed request');
      const {seedSessionBlob}=await import('./dist/azure-session-seed.mjs');
      return {status:200,jsonBody:await seedSessionBlob({blobEndpoint:process.env.AZURE_BLOB_ENDPOINT,runId:body.runId,kind:body.kind,
        marker:body.marker,azureAccessToken:body.azureAccessToken,expectedPrincipalId:body.expectedPrincipalId})};
    } catch {return {status:400,jsonBody:{error:'session seed failed'}};}
  }
});

app.http('thesisRun', {
  methods:['POST'], route:'run', authLevel:'function',
  handler:async(request)=>{
    if(request.headers.get('x-trial-key')!==process.env.TRIAL_REQUEST_KEY)
      return {status:403,jsonBody:{error:'controller authorization required'}};
    try{
      const data=await request.json();
      const scenarioInput=prepareRunRequest(data);
      if(!scenarioInput||!SCENARIOS.includes(scenarioInput.scenario))
        return {status:400,jsonBody:{error:'invalid run request'}};
      const workloadToken=authMode==='delegated'?data.mockWorkloadToken:process.env.WORKLOAD_TOKEN;
      if(typeof workloadToken!=='string' || !workloadToken || /[\r\n]/.test(workloadToken) ||
        (authMode==='delegated' && (workloadToken.length<32 || workloadToken.length>512))) throw new Error('missing or invalid workload credential');
      if(blobRunner && blobScenarios.has(scenarioInput.scenario)) return {status:200,jsonBody:await blobRunner({runId:scenarioInput.runId,scenario:scenarioInput.scenario,
        ...(typeof scenarioInput.requestId==='string'?{requestId:scenarioInput.requestId}:{})})};
      if(delegatedFactory && blobScenarios.has(scenarioInput.scenario)) return {status:200,jsonBody:await delegatedFactory(scenarioInput)({runId:scenarioInput.runId,scenario:scenarioInput.scenario,
        ...(typeof scenarioInput.requestId==='string'?{requestId:scenarioInput.requestId}:{})})};
      const result=await runScenario(scenarioInput,{
        resourceUrl:process.env.RESEARCH_URL,
        collectorUrl:process.env.COLLECTOR_URL,
        restrictedUrl:process.env.RESTRICTED_URL,
        workloadToken
      });
      if(scenarioInput.runId.startsWith('pilot-')&&['U5','U7'].includes(scenarioInput.scenario)&&
        authMode==='managed'&&managedGetBlobToken&&process.env.AZURE_CLIENT_ID) {
        const {managedIdentityClaims}=await import('./dist/azure-blob-workload.mjs');
        const identity=managedIdentityClaims(await managedGetBlobToken(),{expectedClientId:process.env.AZURE_CLIENT_ID});
        return {status:200,jsonBody:{...result,workloadIdentity:{objectId:identity.objectId,clientId:identity.clientId}}};
      }
      return {status:200,jsonBody:result};
    }catch(e){
      // Errors from Azure storage, the research service, and identity
      // credentials can contain URLs, request details, or sensitive context.
      // Keep the client response generic and never serialize exception text.
      console.error(JSON.stringify({event:'trial_execution_failed',errorType:e?.name || 'Error'}));
      return {status:500,jsonBody:{error:'trial execution failed'}};
    }
  }
});
