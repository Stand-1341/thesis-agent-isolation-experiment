import { app } from '@azure/functions';
import { SCENARIOS, runScenario } from './dist/core.js';
import { probeNetwork } from './dist/network-probe.mjs';

const blobScenarios=new Set(['U1','U2','U3','U6','U8','L1','L2']);
const authMode=process.env.AZURE_TOKEN_MODE || 'managed';
if(!['managed','delegated'].includes(authMode) || (authMode==='delegated' && (!process.env.AZURE_BLOB_ENDPOINT || !!process.env.WORKLOAD_TOKEN || !!process.env.AZURE_CLIENT_ID))) throw new Error('invalid Azure token mode');
let blobRunner,delegatedFactory;
if(process.env.AZURE_BLOB_ENDPOINT) {
  const endpoint=process.env.AZURE_BLOB_ENDPOINT;
  const {createBlobWorkload}=await import('./dist/azure-blob-workload.mjs');
  if(authMode==='managed') {
    const {createManagedStorageTokenProvider}=await import('./dist/azure-managed-token.mjs');
    blobRunner=createBlobWorkload({blobEndpoint:endpoint,getToken:createManagedStorageTokenProvider({clientId:process.env.AZURE_CLIENT_ID || undefined}),
      dummyApiUrl:process.env.RESEARCH_URL,dummyApiWorkloadToken:process.env.WORKLOAD_TOKEN});
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
    return {status:200,jsonBody:await probeNetwork(`${process.env.RESEARCH_URL}/health`,`${process.env.COLLECTOR_URL}/health`,{restrictedIp:process.env.PROBE_RESTRICTED_IP,redirectUrl:process.env.PROBE_REDIRECT_URL})};
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
      if(!data||typeof data!=='object'||typeof data.runId!=='string'||
         !/^[a-zA-Z0-9_-]{1,150}$/.test(data.runId)||!SCENARIOS.includes(data.scenario))
        return {status:400,jsonBody:{error:'invalid run request'}};
      const workloadToken=authMode==='delegated'?data.mockWorkloadToken:process.env.WORKLOAD_TOKEN;
      if(typeof workloadToken!=='string' || !workloadToken || /[\r\n]/.test(workloadToken) ||
        (authMode==='delegated' && (workloadToken.length<32 || workloadToken.length>512))) throw new Error('missing or invalid workload credential');
      if(blobRunner && blobScenarios.has(data.scenario)) return {status:200,jsonBody:await blobRunner({runId:data.runId,scenario:data.scenario})};
      if(delegatedFactory && blobScenarios.has(data.scenario)) return {status:200,jsonBody:await delegatedFactory(data)({runId:data.runId,scenario:data.scenario})};
      const result=await runScenario(data,{
        resourceUrl:process.env.RESEARCH_URL,
        collectorUrl:process.env.COLLECTOR_URL,
        workloadToken
      });
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
