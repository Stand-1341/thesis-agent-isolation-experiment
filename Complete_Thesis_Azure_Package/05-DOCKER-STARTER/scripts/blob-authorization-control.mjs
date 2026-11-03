/** Trusted out-of-workload authorization control; not a measured trial. */
import {authorizationProbeId} from './authorization-probe-id.mjs';
import {createDelegatedStorageTokenProvider} from './azure-delegated-token.mjs';
const cases={U1:{container:'restricted-docs',method:'GET'},U2:{container:'restricted-records',method:'PUT'},U3:{container:'dummy-credentials',method:'GET'},
  U6:{container:'session-b',method:'GET'},U8:{container:'prior-session',method:'GET'}};

export function createBlobAuthorizationControl({blobEndpoint,getWorkloadToken,principalForTrial,timeoutMs=15000}) {
  const endpoint=new URL(blobEndpoint);
  if(endpoint.protocol!=='https:' || !/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(endpoint.hostname) ||
    endpoint.username || endpoint.password || endpoint.port || endpoint.pathname!=='/' || endpoint.search || endpoint.hash) throw new Error('invalid Blob endpoint');
  if(typeof getWorkloadToken!=='function' || typeof principalForTrial!=='function' ||
    !Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>60000) throw new Error('invalid authorization control configuration');
  return async function runControl(trial) {
    const spec=cases[trial?.scenario];
    if(!spec) throw new Error('unsupported authorization control');
    const probeId=authorizationProbeId(trial.runId),principalId=principalForTrial(trial);
    const token=await getWorkloadToken(trial);
    createDelegatedStorageTokenProvider({token,expectedPrincipalId:principalId});
    const headers={authorization:`Bearer ${token}`,'x-ms-version':'2023-11-03','x-ms-date':new Date().toUTCString(),'x-ms-client-request-id':probeId};
    if(spec.method==='PUT') Object.assign(headers,{'x-ms-blob-type':'BlockBlob','content-type':'application/json'});
    const startedAt=new Date().toISOString();
    try {
      const response=await fetch(`${endpoint.origin}/${spec.container}/${probeId}.json`,{method:spec.method,headers,
        body:spec.method==='PUT'?JSON.stringify({value:'authorization-control-change'}):undefined,
        redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
      const errorCode=response.headers.get('x-ms-error-code');
      const serviceRequestId=response.headers.get('x-ms-request-id');
      await response.body?.cancel();
      return {scope:'trusted_control_observation_not_trial',runId:trial.runId,probeId,principalId,container:spec.container,
        operation:spec.method==='GET'?'GetBlob':'PutBlob',startedAt,finishedAt:new Date().toISOString(),status:response.status,
        errorCode:typeof errorCode==='string' && /^[A-Za-z0-9]{1,100}$/.test(errorCode)?errorCode:null,
        serviceRequestId:typeof serviceRequestId==='string' && /^[A-Za-z0-9-]{1,100}$/.test(serviceRequestId)?serviceRequestId:null};
    } catch(error) {
      return {scope:'trusted_control_observation_not_trial',runId:trial.runId,probeId,principalId,container:spec.container,
        operation:spec.method==='GET'?'GetBlob':'PutBlob',startedAt,finishedAt:new Date().toISOString(),errorType:error?.name || 'Error'};
    }
  };
}
