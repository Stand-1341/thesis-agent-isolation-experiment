/** Token-free controller HTTP adapter for identity-bound ACI session operations.
 *
 * Workload identities acquire and use their own ManagedIdentityCredential
 * inside their ACI group. This controller helper sends only synthetic marker
 * values and operation metadata over the private endpoint; it never receives
 * or forwards a workload access token. No Azure calls are made at construction.
 */
import {createHash,randomBytes,randomUUID} from 'node:crypto';

const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN=/^[A-Za-z0-9_-]{1,150}$/;
const REQUEST_ID=/^[A-Za-z0-9_-]{12,100}$/;
const SERVICE_ID=/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9._()-]+\/providers\/Microsoft\.Storage\/storageAccounts\/([a-z0-9]{3,24})\/blobServices\/default$/i;
const CONTAINER_BY_SCENARIO=Object.freeze({U6:'session-b',U8:'prior-session'});
const PRIVATE_IP=value=>{
  const parts=String(value||'').split('.').map(Number);
  if(parts.length!==4||parts.some(part=>!Number.isInteger(part)||part<0||part>255)) return false;
  return parts[0]===10||(parts[0]===172&&parts[1]>=16&&parts[1]<=31)||(parts[0]===192&&parts[1]===168);
};
function requireFn(value,name) {if(typeof value!=='function') throw new Error(`ACI session HTTP adapter requires ${name}`);}
function identity(value) {
  if(!value||!GUID.test(value.objectId||'')||!GUID.test(value.clientId||'')) throw new Error('invalid session HTTP identity');
  return value.objectId.toLowerCase();
}
function targetFor({trial,container,target,endpoint,blobServiceResourceId}) {
  const expectedResourceId=`${blobServiceResourceId}/containers/${container}`;
  if(!trial||!RUN.test(trial.runId||'')||CONTAINER_BY_SCENARIO[trial.scenario]!==container||!target||
    target.resourceId?.toLowerCase()!==expectedResourceId.toLowerCase())
    throw new Error('session HTTP target does not match the run and scenario');
  let url;try {url=new URL(target.objectUri);} catch {throw new Error('invalid session HTTP Blob URI');}
  if(url.protocol!=='https:'||!/^([a-z0-9]{3,24})\.blob\.core\.windows\.net$/i.test(url.hostname)||
    url.hostname.toLowerCase()!==endpoint.hostname.toLowerCase()||
    url.pathname!==`/${container}/${trial.runId}.json`||url.search||url.hash||url.username||url.password)
    throw new Error('session HTTP Blob URI is not the exact run marker');
}
function makeRequestId(runId,operation) {
  const digest=createHash('sha256').update(`${runId}\n${operation}\n${randomUUID()}`,'utf8').digest('hex');
  return `aci-${operation}-${digest}`;
}
function validRequestId(value) {return typeof value==='string'&&REQUEST_ID.test(value);}
function validFingerprint(value) {return typeof value==='string'&&/^sha256:[a-f0-9]{64}$/i.test(value);}
function validEtag(value) {return typeof value==='string'&&/^"[^"\r\n]{1,196}"$/.test(value);}
function validTime(value) {return typeof value==='string'&&Number.isFinite(Date.parse(value));}
function decodeCapture(value,{statusCode,requestId,principalId,boundary}) {
  if(!value||typeof value.bodyBase64!=='string'||value.bodyBase64.length>4096||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.bodyBase64)||
    value.statusCode!==statusCode||value.requestId!==requestId||value.principalId?.toLowerCase()!==principalId.toLowerCase()||
    !validTime(value.capturedAt)||value.captureBoundary!==boundary)
    throw new Error('ACI marker response-byte capture is missing or mismatched');
  const bodyBytes=Buffer.from(value.bodyBase64,'base64');
  if(bodyBytes.toString('base64')!==value.bodyBase64) throw new Error('ACI marker response-byte capture encoding is invalid');
  return {bodyBytes,statusCode,requestId,principalId:principalId.toLowerCase(),capturedAt:value.capturedAt,captureBoundary:boundary};
}

export function createAciAgentSessionHttpCallbacks({controllerToken,blobEndpoint,fetchImpl=fetch,timeoutMs=20000,
  blobServiceResourceId,runCleanupWithIdentity}={}) {
  let endpoint;try {endpoint=new URL(blobEndpoint);} catch {throw new Error('invalid ACI session Blob endpoint');}
  const serviceMatch=SERVICE_ID.exec(blobServiceResourceId||'');
  if(endpoint.protocol!=='https:'||!/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/i.test(endpoint.hostname)||
    endpoint.port||endpoint.username||endpoint.password||endpoint.pathname!=='/'||endpoint.search||endpoint.hash||!serviceMatch||
    `${serviceMatch[1]}.blob.core.windows.net`!==endpoint.hostname.toLowerCase())
    throw new Error('invalid ACI session Blob endpoint');
  if(typeof controllerToken!=='string'||controllerToken.length<16||/[\r\n]/.test(controllerToken)||typeof fetchImpl!=='function'||
    !Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>60000) throw new Error('invalid ACI session HTTP configuration');
  requireFn(runCleanupWithIdentity,'an independently confirmed cleanup-group lifecycle callback');

  async function post(group,path,body) {
    if(!group||!/^thesis-aci-(p1|p2)-[a-f0-9]{24}$/.test(group.name||'')||!PRIVATE_IP(group.privateIp))
      throw new Error('session HTTP operation requires a ready private ACI group');
    let response;try {response=await fetchImpl(`http://${group.privateIp}:8080${path}`,{method:'POST',redirect:'error',
      headers:{'content-type':'application/json','x-trial-key':controllerToken},body:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});}
    catch {throw new Error('ACI private session operation transport failed');}
    if(!response.ok) {await response.body?.cancel();throw new Error(`ACI private session operation HTTP ${response.status}`);}
    let data;try {data=await response.json();} catch {throw new Error('ACI private session operation returned invalid JSON');}
    return data;
  }

  return Object.freeze({
    async seedMarker({trial,group,identity:sourceIdentity,container,target}) {
      targetFor({trial,container,target,endpoint,blobServiceResourceId});
      const principalId=identity(sourceIdentity),requestId=makeRequestId(trial.runId,'seed');
      if(group?.identityObjectId?.toLowerCase()!==principalId) throw new Error('ACI seed group is not bound to the source identity');
      // The synthetic marker is sent to the source group but is never returned
      // by the group API. Only its SHA-256 fingerprint leaves that process.
      const marker=`SYNTHETIC-${randomBytes(32).toString('hex')}`;
      const data=await post(group,'/session-seed',{runId:trial.runId,kind:container,marker,requestId});
      if(data?.runId!==trial.runId||data?.container!==container||data?.requestId!==requestId||
        data?.principalId?.toLowerCase()!==principalId||data?.resourceId!==target.resourceId||data?.objectUri!==target.objectUri||
        !Number.isInteger(data?.statusCode)||!validTime(data?.startedAt)||!validFingerprint(data?.markerFingerprint)||
        (data.statusCode===201&&!validEtag(data.etag))) throw new Error('ACI session seed observation did not match the request');
      const contentCapture=data.statusCode===201?decodeCapture(data.contentCapture,{statusCode:201,requestId,principalId,
        boundary:'blob_request_body'}):undefined;
      return {runId:data.runId,container:data.container,statusCode:data.statusCode,principalId:data.principalId,
        resourceId:data.resourceId,objectUri:data.objectUri,requestId:data.requestId,startedAt:data.startedAt,
        markerFingerprint:data.markerFingerprint,...(validEtag(data.etag)?{etag:data.etag}:{}),
        ...(contentCapture?{contentCapture}:{}),
        ...(typeof data.errorCode==='string'&&/^[A-Za-z][A-Za-z0-9]{0,79}$/.test(data.errorCode)?{errorCode:data.errorCode}:{})};
    },
    async attemptRead({trial,group,identity:probeIdentity,container,resourceId,sourceGroup,sourceGroupMustRemainActive}) {
      const target={resourceId,objectUri:`${endpoint.origin}/${container}/${trial?.runId}.json`};
      // Validate the object path independently of the target URL supplied by
      // the controller so arbitrary container/object reads cannot be requested.
      const expectedContainer=CONTAINER_BY_SCENARIO[trial?.scenario];
      if(!trial||!RUN.test(trial.runId||'')||expectedContainer!==container||
        typeof resourceId!=='string'||!resourceId.toLowerCase().endsWith(`/containers/${container}`)||
        !group||!PRIVATE_IP(group.privateIp)||group.identityObjectId?.toLowerCase()!==identity(probeIdentity)||
        (trial.scenario==='U6'&&(sourceGroupMustRemainActive!==true||!sourceGroup?.name)))
        throw new Error('ACI probe identity or target does not match the run');
      targetFor({trial,container,target,endpoint,blobServiceResourceId});
      const requestId=makeRequestId(trial.runId,'probe');
      const data=await post(group,'/run',{runId:trial.runId,scenario:trial.scenario,requestId});
      if(data?.runId!==trial.runId||data?.scenario!==trial.scenario||data?.requestId!==requestId||
        data?.principalId?.toLowerCase()!==identity(probeIdentity)||data?.resourceId!==resourceId||data?.objectUri!==target.objectUri||
        !Number.isInteger(data?.statusCode)||!validTime(data?.startedAt)||
        (data.statusCode===200&&data.markerFingerprint!==undefined&&!validFingerprint(data.markerFingerprint)))
        throw new Error('ACI session probe observation did not match the request');
      const contentCapture=data.statusCode===200?decodeCapture(data.contentCapture,{statusCode:200,requestId,principalId:identity(probeIdentity),
        boundary:'blob_response_body'}):undefined;
      // Retain response bytes only in this in-process transient capture for the
      // protected marker-proof writer. The session analogue strips this value
      // and trial evidence stores only the protected reference/hash.
      return {runId:data.runId,container,statusCode:data.statusCode,principalId:data.principalId,resourceId:data.resourceId,
        objectUri:data.objectUri,requestId:data.requestId,startedAt:data.startedAt,groupName:group.name,
        ...(contentCapture?{contentCapture}:{}),...(data.statusCode===403&&validTime(data.observedAt)?{observedAt:data.observedAt}:{}),
        ...(trial.scenario==='U6'?{sourceGroupActiveAtProbe:true}:{}),
        ...(data.statusCode===200?(validFingerprint(data.markerFingerprint)?{markerFingerprint:data.markerFingerprint}:{}) :
          (typeof data.errorCode==='string'&&/^[A-Za-z][A-Za-z0-9]{0,79}$/.test(data.errorCode)?{errorCode:data.errorCode}:{}))};
    },
    async deleteMarker({trial,container,target,identity:cleanupIdentity,markerFingerprint,etag}) {
      targetFor({trial,container,target,endpoint,blobServiceResourceId});
      const principalId=identity(cleanupIdentity);
      if(!validFingerprint(markerFingerprint)||!validEtag(etag)) throw new Error('ACI marker cleanup requires the exact fingerprint and seed ETag');
      const requestId=makeRequestId(trial.runId,'delete');
      let operation;
      try {operation=await runCleanupWithIdentity({trial,container,target,identity:cleanupIdentity,markerFingerprint,etag,requestId,
        invoke:group=>post(group,'/session-delete',{runId:trial.runId,kind:container,markerFingerprint,etag,requestId})});}
      catch {throw new Error('ACI cleanup identity operation or group cleanup failed');}
      const data=operation?.output??operation;
      if(operation?.cleanupConfirmed!==true) throw new Error('ACI cleanup group absence was not independently confirmed');
      if(data?.runId!==trial.runId||data?.container!==container||data?.requestId!==requestId||
        data?.principalId?.toLowerCase()!==principalId||data?.resourceId!==target.resourceId||data?.objectUri!==target.objectUri||
        !Number.isInteger(data?.statusCode)||!validTime(data?.startedAt)||typeof data?.removed!=='boolean')
        throw new Error('ACI session delete observation did not match the request');
      return {runId:data.runId,container:data.container,resourceId:data.resourceId,objectUri:data.objectUri,
        requestId:data.requestId,startedAt:data.startedAt,statusCode:data.statusCode,principalId:data.principalId,
        removed:data.removed,...(typeof data.errorCode==='string'&&/^[A-Za-z][A-Za-z0-9]{0,79}$/.test(data.errorCode)?{errorCode:data.errorCode}:{})};
    }
  });
}

