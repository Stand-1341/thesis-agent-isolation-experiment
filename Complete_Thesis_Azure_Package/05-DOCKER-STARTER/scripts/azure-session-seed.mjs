/** Candidate trusted fixture-session write; not a measured trial. */
import {createHash} from 'node:crypto';
import {createDelegatedStorageTokenProvider} from './azure-delegated-token.mjs';
export function sessionSeedRequestId(runId,kind) {
  if(!/^[A-Za-z0-9_-]{1,150}$/.test(runId || '') || !['session-b','prior-session'].includes(kind)) throw new Error('invalid session seed request');
  return `seed-${createHash('sha256').update(`${runId}:${kind}`,'utf8').digest('hex')}`;
}
export async function seedSessionBlob({blobEndpoint,runId,kind,marker,azureAccessToken,getManagedToken,expectedPrincipalId,timeoutMs=15000}) {
  const requestId=sessionSeedRequestId(runId,kind);
  if(typeof marker!=='string' || !/^SYNTHETIC-[A-Za-z0-9-]{1,100}$/.test(marker) || !Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>60000) throw new Error('invalid synthetic session marker');
  const endpoint=new URL(blobEndpoint);
  if(endpoint.protocol!=='https:' || !/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(endpoint.hostname) ||
    endpoint.port || endpoint.username || endpoint.password || endpoint.pathname!=='/' || endpoint.search || endpoint.hash) throw new Error('invalid Blob endpoint');
  if((typeof azureAccessToken==='string') === (typeof getManagedToken==='function')) throw new Error('exactly one fixture token source is required');
  // The managed provider must belong to a separately deployed fixture identity.
  // The token claim check is only a shape/identity check; Azure authenticates it.
  const suppliedToken=getManagedToken ? await getManagedToken() : azureAccessToken;
  const getToken=createDelegatedStorageTokenProvider({token:suppliedToken,expectedPrincipalId});
  const token=await getToken();
  const response=await fetch(`${endpoint.origin}/${kind}/${runId}.json`,{method:'PUT',redirect:'error',signal:AbortSignal.timeout(timeoutMs),
    headers:{authorization:`Bearer ${token}`,'x-ms-version':'2023-11-03','x-ms-date':new Date().toUTCString(),
      'x-ms-client-request-id':requestId,'x-ms-blob-type':'BlockBlob','content-type':'application/json','if-none-match':'*'},
    body:JSON.stringify({marker})});
  if(!response.ok) throw new Error(`session seed HTTP ${response.status}`);
  const serviceRequestId=response.headers.get('x-ms-request-id');
  await response.body?.cancel();
  return {scope:'fixture_session_seed_observation',runId,kind,requestId,status:response.status,
    serviceRequestId:typeof serviceRequestId==='string' && /^[A-Za-z0-9-]{1,100}$/.test(serviceRequestId)?serviceRequestId:null};
}
