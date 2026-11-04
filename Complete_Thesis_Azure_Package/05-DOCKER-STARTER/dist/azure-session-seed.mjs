/** Candidate trusted fixture-session write; not a measured trial. */
import {createHash} from 'node:crypto';
import {createDelegatedStorageTokenProvider} from './azure-delegated-token.mjs';

const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORAGE_SERVICE_ID=/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9._()-]+\/providers\/Microsoft\.Storage\/storageAccounts\/([a-z0-9]{3,24})\/blobServices\/default$/i;
const REQUEST_ID=/^[A-Za-z0-9_-]{12,100}$/;

export function sessionSeedRequestId(runId,kind) {
  if(!/^[A-Za-z0-9_-]{1,150}$/.test(runId || '') || !['session-b','prior-session'].includes(kind)) throw new Error('invalid session seed request');
  return `seed-${createHash('sha256').update(`${runId}:${kind}`,'utf8').digest('hex')}`;
}

function validateBlobScope({blobEndpoint,runId,kind,expectedPrincipalId,expectedResourceId}) {
  if(!/^[A-Za-z0-9_-]{1,150}$/.test(runId||'')||!['session-b','prior-session'].includes(kind)||!GUID.test(expectedPrincipalId||''))
    throw new Error('invalid synthetic session operation');
  let endpoint;try {endpoint=new URL(blobEndpoint);} catch {throw new Error('invalid Blob endpoint');}
  if(endpoint.protocol!=='https:'||!/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(endpoint.hostname)||
    endpoint.port||endpoint.username||endpoint.password||endpoint.pathname!=='/'||endpoint.search||endpoint.hash)
    throw new Error('invalid Blob endpoint');
  const serviceId=String(expectedResourceId||'');
  const service=STORAGE_SERVICE_ID.exec(serviceId);
  if(!service||`${service[1]}.blob.core.windows.net`!==endpoint.hostname)
    throw new Error('Blob resource ID does not match the configured endpoint');
  return {endpoint,resourceId:`${serviceId}/containers/${kind}`,objectUri:`${endpoint.origin}/${kind}/${runId}.json`};
}
function validateRequestId(value) {
  if(typeof value!=='string'||!REQUEST_ID.test(value)) throw new Error('invalid Blob operation request ID');
  return value;
}
function validateTokenClient(token,expectedClientId) {
  if(!GUID.test(expectedClientId)) throw new Error('invalid expected managed identity client ID');
  let claims;
  try {claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'));} catch {throw new Error('managed identity token could not be verified');}
  const clientId=claims?.azp??claims?.appid;
  if(typeof clientId!=='string'||clientId.toLowerCase()!==expectedClientId.toLowerCase())
    throw new Error('managed identity token client does not match the attached identity');
}
function safeEtag(value) {
  return typeof value==='string'&&value.length<=200&&/^"[^"\r\n]{1,196}"$/.test(value);
}
function fingerprint(body) {return `sha256:${createHash('sha256').update(body,'utf8').digest('hex')}`;}
function transportError(operation) {return new Error(`session ${operation} transport failed`);}

export async function seedSessionBlob({blobEndpoint,runId,kind,marker,azureAccessToken,getManagedToken,expectedPrincipalId,
  expectedClientId,expectedResourceId,requestId:requestedRequestId,timeoutMs=15000,fetchImpl=fetch,now=Date.now}) {
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000||typeof fetchImpl!=='function'||typeof now!=='function') throw new Error('invalid synthetic session seed configuration');
  if(typeof marker!=='string' || !/^SYNTHETIC-[A-Za-z0-9-]{1,100}$/.test(marker) || !Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>60000) throw new Error('invalid synthetic session marker');
  const managed=typeof getManagedToken==='function';
  if(managed&&requestedRequestId!==undefined&&!/^SYNTHETIC-[a-f0-9]{64}$/.test(marker)) throw new Error('managed session marker must be an exact synthetic value');
  let scope;
  if(managed) scope=validateBlobScope({blobEndpoint,runId,kind,expectedPrincipalId,expectedResourceId});
  else {
    let endpoint;try {endpoint=new URL(blobEndpoint);} catch {throw new Error('invalid Blob endpoint');}
    if(endpoint.protocol!=='https:'||!/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(endpoint.hostname)||
      endpoint.port||endpoint.username||endpoint.password||endpoint.pathname!=='/'||endpoint.search||endpoint.hash)
      throw new Error('invalid Blob endpoint');
    scope={endpoint,objectUri:`${endpoint.origin}/${kind}/${runId}.json`};
  }
  if((typeof azureAccessToken==='string') === (typeof getManagedToken==='function')) throw new Error('exactly one fixture token source is required');
  if(!managed&&requestedRequestId!==undefined) throw new Error('explicit request IDs are reserved for managed ACI session seed operations');
  const requestId=requestedRequestId===undefined?sessionSeedRequestId(runId,kind):validateRequestId(requestedRequestId);
  if(managed&&!STORAGE_SERVICE_ID.test(expectedResourceId||'')) throw new Error('managed session seed requires the exact Azure Blob resource ID');
  const suppliedToken=getManagedToken ? await getManagedToken() : azureAccessToken;
  if(managed&&requestedRequestId!==undefined) validateTokenClient(suppliedToken,expectedClientId);
  const getToken=createDelegatedStorageTokenProvider({token:suppliedToken,expectedPrincipalId});
  const token=await getToken();
  const body=JSON.stringify({marker}),markerFingerprint=fingerprint(body),startedAt=new Date(now()).toISOString();
  let response;try {response=await fetchImpl(scope.objectUri,{method:'PUT',redirect:'error',signal:AbortSignal.timeout(timeoutMs),
    headers:{authorization:`Bearer ${token}`,'x-ms-version':'2023-11-03','x-ms-date':new Date().toUTCString(),
      'x-ms-client-request-id':requestId,'x-ms-blob-type':'BlockBlob','content-type':'application/json','if-none-match':'*',
      'x-ms-meta-marker-fingerprint':markerFingerprint,'x-ms-meta-run-id':runId,'x-ms-meta-scenario':kind},body});}
  catch {throw transportError('seed');}
  if(!response.ok&&!managed) {await response.body?.cancel();throw new Error(`session seed HTTP ${response.status}`);}
  const serviceRequestId=response.headers.get('x-ms-request-id');
  const etag=response.headers.get('etag');
  await response.body?.cancel();
  // Preserve the earlier delegated fixture contract. The managed ACI lifecycle
  // receives run-bound metadata required by its independent auditor and cleaner.
  if(!managed&&requestedRequestId===undefined) return {scope:'fixture_session_seed_observation',runId,kind,requestId,status:response.status,
    serviceRequestId:typeof serviceRequestId==='string' && /^[A-Za-z0-9-]{1,100}$/.test(serviceRequestId)?serviceRequestId:null};
  if(response.status===201&&!safeEtag(etag)) throw new Error('managed session seed did not return a valid ETag');
  return {scope:'fixture_session_seed_observation',runId,kind,requestId,status:response.status,
    statusCode:response.status,container:kind,principalId:expectedPrincipalId.toLowerCase(),resourceId:scope.resourceId,
    objectUri:scope.objectUri,startedAt,markerFingerprint,...(safeEtag(etag)?{etag}:{}),
    ...(managed&&requestedRequestId!==undefined&&response.status===201?{contentCapture:{
      bodyBase64:Buffer.from(body,'utf8').toString('base64'),statusCode:response.status,requestId,
      principalId:expectedPrincipalId.toLowerCase(),capturedAt:startedAt,captureBoundary:'blob_request_body'}}:{}),
    ...(response.status===403?{errorCode:response.headers.get('x-ms-error-code')||undefined}:{}),
    serviceRequestId:typeof serviceRequestId==='string' && /^[A-Za-z0-9-]{1,100}$/.test(serviceRequestId)?serviceRequestId:null};
}

export async function deleteSessionBlob({blobEndpoint,runId,kind,markerFingerprint,etag,requestId,expectedPrincipalId,
  expectedClientId,expectedResourceId,getManagedToken,timeoutMs=15000,fetchImpl=fetch,now=Date.now}) {
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000||typeof fetchImpl!=='function'||typeof now!=='function'||
    typeof getManagedToken!=='function'||!/^sha256:[a-f0-9]{64}$/i.test(markerFingerprint||'')||!safeEtag(etag))
    throw new Error('invalid managed session delete configuration');
  const scope=validateBlobScope({blobEndpoint,runId,kind,expectedPrincipalId,expectedResourceId});
  validateRequestId(requestId);
  const suppliedToken=await getManagedToken();
  validateTokenClient(suppliedToken,expectedClientId);
  const token=await createDelegatedStorageTokenProvider({token:suppliedToken,expectedPrincipalId})();
  const headers={'authorization':`Bearer ${token}`,'x-ms-version':'2023-11-03','x-ms-date':new Date(now()).toUTCString(),
    'x-ms-client-request-id':`${requestId}-head`};
  let head;try {head=await fetchImpl(scope.objectUri,{method:'HEAD',headers,redirect:'error',signal:AbortSignal.timeout(timeoutMs)});}
  catch {throw transportError('delete verification');}
  if(head.status===200) {
    const storedFingerprint=head.headers.get('x-ms-meta-marker-fingerprint'),storedEtag=head.headers.get('etag');
    await head.body?.cancel();
    if(storedFingerprint!==markerFingerprint||storedEtag!==etag) throw new Error('session marker fingerprint or ETag does not match');
  } else {
    await head.body?.cancel();
    if(head.status!==404) throw new Error(`session delete verification HTTP ${head.status}`);
  }
  const startedAt=new Date(now()).toISOString();
  let response;try {response=await fetchImpl(scope.objectUri,{method:'DELETE',headers:{...headers,'x-ms-date':new Date(Date.parse(startedAt)).toUTCString(),
    'x-ms-client-request-id':requestId,'if-match':etag},redirect:'error',signal:AbortSignal.timeout(timeoutMs)});}
  catch {throw transportError('delete');}
  await response.body?.cancel();
  const removed=[202,404].includes(response.status);
  return {runId,kind,container:kind,resourceId:scope.resourceId,objectUri:scope.objectUri,requestId,startedAt,
    statusCode:response.status,principalId:expectedPrincipalId.toLowerCase(),removed,
    ...(response.status===403?{errorCode:response.headers.get('x-ms-error-code')||undefined}:{})};
}
