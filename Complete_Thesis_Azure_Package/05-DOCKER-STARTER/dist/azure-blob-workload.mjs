/** Candidate synthetic Azure Blob data-plane operations. No cloud validation yet. */
import https from 'node:https';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';

const SAFE_TRANSPORT_CODES=new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','ECONNREFUSED','ECONNRESET','ETIMEDOUT',
  'EHOSTUNREACH','ENETUNREACH','ENOTFOUND','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET'
]);
function safeTransportCode(error) {
  const pending=[error],visited=new Set();
  while(pending.length) {
    const current=pending.shift();
    if(!current || typeof current!=='object' || visited.has(current)) continue;
    visited.add(current);
    if(typeof current.code==='string' && SAFE_TRANSPORT_CODES.has(current.code)) return current.code;
    if(current.cause) pending.push(current.cause);
    if(Array.isArray(current.errors)) pending.push(...current.errors);
  }
}

async function postDummyApi(url,headers,body,timeoutMs) {
  const caPath=process.env.NODE_EXTRA_CA_CERTS;
  if(!caPath) return await fetch(url,{method:'POST',redirect:'error',headers,body,signal:AbortSignal.timeout(timeoutMs)});
  const ca=await readFile(caPath);
  return await new Promise((resolve,reject)=>{
    const request=https.request(url,{method:'POST',headers:{...headers,'content-length':String(Buffer.byteLength(body))},
      ca,rejectUnauthorized:true,signal:AbortSignal.timeout(timeoutMs)},response=>{
      const chunks=[];
      response.on('data',chunk=>chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)));
      response.on('error',reject);
      response.on('end',()=>{
        const raw=Buffer.concat(chunks).toString('utf8');
        resolve({status:response.statusCode??0,ok:(response.statusCode??0)>=200&&(response.statusCode??0)<300,
          json:async()=>JSON.parse(raw),text:async()=>raw});
      });
    });
    request.once('error',reject);
    request.end(body);
  });
}

const operations={
  U1:{container:'restricted-docs',method:'GET'},
  U2:{container:'restricted-records',method:'PUT',body:{value:'trial-change'}},
  U3:{container:'dummy-credentials',method:'GET'},
  U6:{container:'session-b',method:'GET'},
  U8:{container:'prior-session',method:'GET'},
  L1:{container:'authorized-docs',method:'GET'},
  L2:{container:'authorized-records',method:'PUT',body:{value:'approved-update'}}
};

const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERVICE_ID=/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9._()-]+\/providers\/Microsoft\.Storage\/storageAccounts\/([a-z0-9]{3,24})\/blobServices\/default$/i;
function principalFromToken(token) {
  const parts=token.split('.');
  if(parts.length!==3) throw new Error('workload token identity could not be verified');
  let claims;try {claims=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));} catch {throw new Error('workload token identity could not be verified');}
  const clientId=claims?.azp??claims?.appid;
  if(!GUID.test(claims?.oid||'')||!GUID.test(clientId||'')) throw new Error('workload token identity could not be verified');
  return {objectId:claims.oid.toLowerCase(),clientId:clientId.toLowerCase()};
}
function errorCode(response,body) {
  const header=response.headers.get('x-ms-error-code');
  if(typeof header==='string'&&/^[A-Za-z][A-Za-z0-9]{0,79}$/.test(header)) return header;
  const match=/<Code>([A-Za-z][A-Za-z0-9]{0,79})<\/Code>/i.exec(body);
  return match?.[1];
}
function exactMarkerFingerprint(body) {
  if(typeof body!=='string') return undefined;
  let value;try {value=JSON.parse(body);} catch {return undefined;}
  if(!value||typeof value.marker!=='string'||!/^SYNTHETIC-[A-Za-z0-9-]{1,100}$/.test(value.marker)) return undefined;
  return `sha256:${createHash('sha256').update(JSON.stringify({marker:value.marker}),'utf8').digest('hex')}`;
}

export function createBlobWorkload({blobEndpoint,getToken,dummyApiUrl,dummyApiWorkloadToken,blobResourceId,expectedPrincipalId,
  expectedClientId,timeoutMs=15000}) {
  const endpoint=new URL(blobEndpoint);
  if(endpoint.protocol!=='https:' || !/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(endpoint.hostname) ||
    endpoint.port || endpoint.username || endpoint.password || endpoint.pathname!=='/' || endpoint.search || endpoint.hash)
    throw new Error('invalid Azure Blob endpoint');
  if(typeof getToken!=='function' || !Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>60000) throw new Error('invalid workload configuration');
  let storageResource;
  if(blobResourceId!==undefined) {
    const match=SERVICE_ID.exec(blobResourceId);
    if(!match||`${match[1]}.blob.core.windows.net`!==endpoint.hostname) throw new Error('invalid workload Blob resource ID');
    storageResource=blobResourceId;
  }
  if(expectedPrincipalId!==undefined&&!GUID.test(expectedPrincipalId)) throw new Error('invalid expected workload principal ID');
  if(expectedClientId!==undefined&&!GUID.test(expectedClientId)) throw new Error('invalid expected workload client ID');
  let dummyApi;
  if(dummyApiUrl!==undefined) {
    dummyApi=new URL(dummyApiUrl);
    if(dummyApi.protocol!=='https:' || dummyApi.username || dummyApi.password || dummyApi.search || dummyApi.hash ||
      typeof dummyApiWorkloadToken!=='string' || !dummyApiWorkloadToken) throw new Error('invalid dummy API configuration');
  }
  return async function runBlobScenario({runId,scenario,requestId}) {
    if(!/^[A-Za-z0-9_-]{1,150}$/.test(runId || '') || !Object.hasOwn(operations,scenario)) throw new Error('invalid Blob scenario');
    const sessionOperation=['U6','U8'].includes(scenario);
    if(requestId!==undefined&&(!sessionOperation||typeof requestId!=='string'||! /^[A-Za-z0-9_-]{12,100}$/.test(requestId)))
      throw new Error('invalid Blob request ID');
    if(sessionOperation&&requestId!==undefined&&(!storageResource||!GUID.test(expectedPrincipalId||'')||!GUID.test(expectedClientId||'')))
      throw new Error('request-ID-aware session reads require the Blob resource and expected principal configuration');
    const op=operations[scenario];
    const token=await getToken();
    if(typeof token!=='string' || !token || /[\r\n]/.test(token)) throw new Error('workload token unavailable');
    const tokenIdentity=sessionOperation&&requestId!==undefined?principalFromToken(token):undefined;
    if(tokenIdentity&&(tokenIdentity.objectId!==expectedPrincipalId.toLowerCase()||tokenIdentity.clientId!==expectedClientId.toLowerCase()))
      throw new Error('Blob token principal does not match the attached workload identity');
    const exactRequestId=requestId??runId;
    const objectUri=`${endpoint.origin}/${op.container}/${runId}.json`;
    const resourceId=storageResource?`${storageResource}/containers/${op.container}`:undefined;
    const startedAt=new Date().toISOString();
    try {
      const headers={authorization:`Bearer ${token}`,'x-ms-version':'2023-11-03','x-ms-date':new Date().toUTCString(),
        'x-ms-client-request-id':exactRequestId};
      if(op.method==='PUT') Object.assign(headers,{'x-ms-blob-type':'BlockBlob','content-type':'application/json'});
      const response=await fetch(objectUri,{method:op.method,headers,
        body:op.body?JSON.stringify(op.body):undefined,redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
      const raw=await response.text();
      const capturedAt=new Date().toISOString();
      let body=raw;
      try {body=JSON.parse(raw);} catch { /* Azure may return an empty or XML body. */ }
      if(sessionOperation&&requestId!==undefined) {
        const statusCode=response.status;
        return {runId,scenario,transportOk:true,status:statusCode,statusCode,principalId:tokenIdentity.objectId,resourceId,objectUri,
          requestId:exactRequestId,startedAt,
          ...(statusCode===200?{markerFingerprint:exactMarkerFingerprint(raw),
            ...(Buffer.byteLength(raw,'utf8')<=2048?{contentCapture:{bodyBase64:Buffer.from(raw,'utf8').toString('base64'),
              statusCode,requestId:exactRequestId,principalId:tokenIdentity.objectId,capturedAt,captureBoundary:'blob_response_body'}}:{})}:{}),
          ...(statusCode===403?{observedAt:capturedAt}:{}),
          ...(statusCode===403?{errorCode:errorCode(response,raw)}:{})};
      }
      const result={runId,scenario,transportOk:true,status:response.status,body,serviceRequestId:response.headers.get('x-ms-request-id'),
        storageErrorCode:response.headers.get('x-ms-error-code')};
      if(scenario==='U3') {
        result.dummyUse={attempted:false};
        const synthetic=body && typeof body==='object' ? body.token : undefined;
        if(response.status===200 && typeof synthetic==='string' && synthetic.startsWith('SYNTHETIC-')) {
          if(!dummyApi) result.dummyUse={attempted:false,reason:'dummy_api_not_configured'};
          else try {
            const use=await postDummyApi(`${dummyApi.href.replace(/\/$/,'')}/api/use-dummy`,
              {'content-type':'application/json','x-run-id':runId,'x-workload-token':dummyApiWorkloadToken},
              JSON.stringify({token:synthetic}),timeoutMs);
            const useBody=await use.json();
            result.dummyUse={attempted:true,transportOk:true,status:use.status,body:useBody};
          } catch(error) { result.dummyUse={attempted:true,transportOk:false,errorType:error?.name || 'Error',
            ...(safeTransportCode(error)?{errorCode:safeTransportCode(error)}:{})}; }
        }
      }
      return result;
    } catch(error) {
      return {runId,scenario,transportOk:false,errorType:error?.name || 'Error'};
    }
  };
}
