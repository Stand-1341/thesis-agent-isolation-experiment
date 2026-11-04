/** Candidate run-scoped Blob marker operations for the ACI U6/U8 analogue.
 *
 * All data-plane calls use a caller-supplied managed-identity token provider
 * bound to the requested identity. This module never accepts SAS/account keys,
 * prints token values, or returns marker contents. It is locally testable but
 * has not been validated against Azure. The caller must still provision the
 * identities/groups and prove each identity-token binding independently.
 */
import {createHash,randomBytes,randomUUID} from 'node:crypto';

const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN=/^[A-Za-z0-9_-]{1,150}$/;
const SERVICE_ID=/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9._()-]+\/providers\/Microsoft\.Storage\/storageAccounts\/([a-z0-9]{3,24})\/blobServices\/default$/i;
const CONTAINER_BY_SCENARIO=Object.freeze({U6:'session-b',U8:'prior-session'});
const VERSION='2023-11-03';

function requireFn(value,name) {
  if(typeof value!=='function') throw new Error(`ACI Blob marker operations require ${name}`);
}
function principalFromJwt(token) {
  const parts=token.split('.');
  if(parts.length!==3) throw new Error('managed identity returned an unverifiable storage token');
  let claims;
  try {claims=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));}
  catch {throw new Error('managed identity returned an unverifiable storage token');}
  const objectId=claims.oid;
  const clientId=claims.azp??claims.appid;
  if(!GUID.test(objectId||'')||!GUID.test(clientId||'')) throw new Error('managed identity token is missing identity claims');
  return {objectId:objectId.toLowerCase(),clientId:clientId.toLowerCase()};
}
function validateIdentity(identity) {
  if(!identity||!GUID.test(identity.objectId||'')||!GUID.test(identity.clientId||''))
    throw new Error('invalid ACI Blob operation identity');
  return {objectId:identity.objectId.toLowerCase(),clientId:identity.clientId.toLowerCase()};
}
function jsonFingerprint(marker) {
  const body=JSON.stringify({marker});
  return {body,fingerprint:`sha256:${createHash('sha256').update(body,'utf8').digest('hex')}`};
}
function uniqueRequestId(runId,operation) {
  const entropy=randomUUID();
  const digest=createHash('sha256').update(`${runId}\n${operation}\n${entropy}`,'utf8').digest('hex');
  return `aci-${operation}-${digest}`;
}
function safeNow(now) {
  const value=now();
  if(!Number.isFinite(value)) throw new Error('ACI Blob operation clock is invalid');
  return new Date(value).toISOString();
}
function safeErrorCode(response,body='') {
  const header=response.headers.get('x-ms-error-code');
  if(typeof header==='string'&&/^[A-Za-z][A-Za-z0-9]{0,79}$/.test(header)) return header;
  const match=/<Code>([A-Za-z][A-Za-z0-9]{0,79})<\/Code>/i.exec(body);
  return match?.[1];
}
function parseMarkerBody(raw) {
  try {
    const value=JSON.parse(raw);
    if(!value||typeof value.marker!=='string'||!/^SYNTHETIC-[a-f0-9]{64}$/.test(value.marker)) return undefined;
    return value.marker;
  } catch {return undefined;}
}
async function readBody(response) {
  try {return await response.text();} catch {throw new Error('Azure Blob response body could not be read');}
}

/**
 * Return the five Blob callbacks required by `createAciBlobSessionAnalog`.
 *
 * `getTokenForIdentity(identity)` must obtain a storage-scoped token for that
 * exact UAI. The returned JWT is identity-checked before use. A separate,
 * independently operated access-review callback is required for the positive
 * read-back control; this module does not infer Azure effective permissions.
 */
export function createAciBlobMarkerOperations({blobServiceResourceId,blobEndpoint,getTokenForIdentity,
  verifierIdentity,readVerifierAccessEvidence,fetchImpl=fetch,timeoutMs=15000,now=Date.now}={}) {
  const match=SERVICE_ID.exec(blobServiceResourceId||'');
  if(!match) throw new Error('invalid Azure Blob service resource ID');
  let endpoint;
  try {endpoint=new URL(blobEndpoint);} catch {throw new Error('invalid Azure Blob service endpoint');}
  const account=match[1].toLowerCase();
  if(endpoint.protocol!=='https:'||endpoint.hostname.toLowerCase()!==`${account}.blob.core.windows.net`||endpoint.port||
    endpoint.username||endpoint.password||endpoint.pathname!=='/'||endpoint.search||endpoint.hash)
    throw new Error('Blob endpoint does not match the configured storage resource');
  requireFn(getTokenForIdentity,'an identity-bound managed-identity token provider');
  requireFn(readVerifierAccessEvidence,'independent verifier access evidence');
  requireFn(fetchImpl,'fetch implementation');requireFn(now,'clock');
  if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>60000) throw new Error('invalid ACI Blob operation timeout');
  const verifier=validateIdentity(verifierIdentity);
  const markers=new Map();

  function targetForMarker({trial,container}) {
    if(!trial||!RUN.test(trial.runId||'')||CONTAINER_BY_SCENARIO[trial.scenario]!==container)
      throw new Error('ACI marker target must match a supported run and scenario');
    return {resourceId:`${blobServiceResourceId}/containers/${container}`,
      objectUri:`${endpoint.origin}/${container}/${trial.runId}.json`};
  }
  async function tokenFor(identity) {
    const expected=validateIdentity(identity);
    let token;
    try {token=await getTokenForIdentity(identity);} catch {throw new Error('managed identity could not obtain a Blob token');}
    if(typeof token!=='string'||!token||/[\r\n]/.test(token)) throw new Error('managed identity returned no Blob token');
    const actual=principalFromJwt(token);
    if(actual.objectId!==expected.objectId||actual.clientId!==expected.clientId)
      throw new Error('Blob token principal does not match the requested identity');
    return token;
  }
  async function blobRequest({identity,target,operation,method,body,etag,requestId}) {
    const token=await tokenFor(identity);
    const startedAt=safeNow(now);
    const headers={authorization:`Bearer ${token}`,'x-ms-version':VERSION,'x-ms-date':new Date(Date.parse(startedAt)).toUTCString(),
      'x-ms-client-request-id':requestId};
    if(method==='PUT') Object.assign(headers,{'x-ms-blob-type':'BlockBlob','content-type':'application/json','if-none-match':'*',
      'x-ms-meta-run-id':target.runId,'x-ms-meta-scenario':target.scenario});
    if(method==='DELETE'&&etag) headers['if-match']=etag;
    let response;
    try {response=await fetchImpl(target.objectUri,{method,headers,...(body===undefined?{}:{body}),redirect:'error',signal:AbortSignal.timeout(timeoutMs)});}
    catch {throw new Error(`Azure Blob ${operation} transport failed`);}
    return {response,startedAt,requestId,principalId:validateIdentity(identity).objectId};
  }

  return Object.freeze({
    targetForMarker,
    async seedMarker({trial,group,identity,container,target}) {
      const expected=targetForMarker({trial,container});
      if(!target||target.resourceId!==expected.resourceId||target.objectUri!==expected.objectUri||group?.identityObjectId?.toLowerCase()!==identity?.objectId?.toLowerCase())
        throw new Error('ACI marker seed target or group identity mismatch');
      if(markers.has(trial.runId)) throw new Error('ACI marker already exists for this run');
      const marker=`SYNTHETIC-${randomBytes(32).toString('hex')}`;
      const {body,fingerprint}=jsonFingerprint(marker),requestId=uniqueRequestId(trial.runId,'put');
      const result=await blobRequest({identity,target:{...target,runId:trial.runId,scenario:trial.scenario},operation:'seed',method:'PUT',body,requestId});
      const {response}=result;
      if(response.status!==201) {await response.body?.cancel();throw new Error(`Azure Blob marker seed returned HTTP ${response.status}`);}
      const etag=response.headers.get('etag');
      if(typeof etag!=='string'||etag.length<2||etag.length>200||/[\r\n]/.test(etag)) {await response.body?.cancel();throw new Error('Azure Blob marker seed has no valid ETag');}
      await response.body?.cancel();
      markers.set(trial.runId,{marker,fingerprint,etag,target:{...target,runId:trial.runId,scenario:trial.scenario},container});
      return {runId:trial.runId,container,statusCode:201,principalId:result.principalId,resourceId:target.resourceId,
        objectUri:target.objectUri,requestId,startedAt:result.startedAt,markerFingerprint:fingerprint,
        contentCapture:{bodyBytes:Buffer.from(body,'utf8'),statusCode:201,requestId,principalId:result.principalId,
          capturedAt:result.startedAt,captureBoundary:'blob_request_body'}};
    },
    async readMarker({trial,container,resourceId,markerFingerprint}) {
      const target=targetForMarker({trial,container});
      if(target.resourceId!==resourceId||!/^sha256:[a-f0-9]{64}$/i.test(markerFingerprint||''))
        throw new Error('ACI independent marker read target or fingerprint mismatch');
      const requestId=uniqueRequestId(trial.runId,'verifier-get');
      const result=await blobRequest({identity:verifierIdentity,target,operation:'verifier read',method:'GET',requestId});
      const raw=await readBody(result.response);
      const marker=parseMarkerBody(raw);
      const actualFingerprint=marker?jsonFingerprint(marker).fingerprint:undefined;
      const capturedAt=safeNow(now);
      let accessEvidence;
      try {accessEvidence=await readVerifierAccessEvidence({identity:verifierIdentity,trial,container,target,observedAt:result.startedAt});}
      catch {throw new Error('independent verifier effective-access evidence unavailable');}
      if(!accessEvidence||!accessEvidence.verifierAccessReview||!accessEvidence.verifierEffectiveAccess)
        throw new Error('independent verifier effective-access evidence is incomplete');
      return {matched:result.response.status===200&&actualFingerprint===markerFingerprint,
        markerFingerprint:actualFingerprint,verifierPrincipalId:result.principalId,resourceId:target.resourceId,objectUri:target.objectUri,
        requestId,startedAt:result.startedAt,
        ...(result.response.status===200&&actualFingerprint?{contentCapture:{bodyBytes:Buffer.from(raw,'utf8'),statusCode:200,
          requestId,principalId:result.principalId,capturedAt,captureBoundary:'blob_response_body'}}:{}),
        verifierAccessReview:accessEvidence.verifierAccessReview,
        verifierEffectiveAccess:accessEvidence.verifierEffectiveAccess};
    },
    async attemptRead({trial,group,identity,container,resourceId,sourceGroup,sourceGroupMustRemainActive}) {
      const target=targetForMarker({trial,container});
      if(target.resourceId!==resourceId||group?.identityObjectId?.toLowerCase()!==identity?.objectId?.toLowerCase()||
        !group?.name||!GUID.test(identity?.objectId||'')) throw new Error('ACI probe group or Blob target mismatch');
      if(trial.scenario==='U6'&&(sourceGroupMustRemainActive!==true||!sourceGroup?.name))
        throw new Error('ACI U6 requires a distinct active source group');
      const requestId=uniqueRequestId(trial.runId,'probe-get');
      const result=await blobRequest({identity,target,operation:'probe read',method:'GET',requestId});
      const raw=await readBody(result.response),statusCode=result.response.status;
      const marker=statusCode===200?parseMarkerBody(raw):undefined;
      const capturedAt=safeNow(now);
      return {runId:trial.runId,container,statusCode,principalId:result.principalId,resourceId:target.resourceId,
        objectUri:target.objectUri,requestId,startedAt:result.startedAt,groupName:group.name,
        ...(statusCode===200&&marker?{contentCapture:{bodyBytes:Buffer.from(raw,'utf8'),statusCode:200,requestId,
          principalId:result.principalId,capturedAt,captureBoundary:'blob_response_body'}}:{}),
        ...(statusCode===403?{observedAt:capturedAt}:{}),
        ...(trial.scenario==='U6'?{sourceGroupActiveAtProbe:sourceGroupMustRemainActive===true}:{}),
        ...(statusCode===200?{...(marker?{markerFingerprint:jsonFingerprint(marker).fingerprint}:{})}:
          {errorCode:statusCode===403?safeErrorCode(result.response,raw):undefined})};
    },
    async deleteMarker({trial,container,target,identity,markerFingerprint}) {
      const expectedTarget=targetForMarker({trial,container}),stored=markers.get(trial.runId);
      if(!stored||stored.fingerprint!==markerFingerprint||target?.resourceId!==expectedTarget.resourceId||target?.objectUri!==expectedTarget.objectUri)
        throw new Error('ACI marker cleanup target or fingerprint mismatch');
      const requestId=uniqueRequestId(trial.runId,'delete'),result=await blobRequest({identity,target:expectedTarget,
        operation:'marker cleanup',method:'DELETE',etag:stored.etag,requestId});
      const {response}=result;
      await response.body?.cancel();
      if(![202,404].includes(response.status)) throw new Error(`Azure Blob marker cleanup returned HTTP ${response.status}`);
      markers.delete(trial.runId);
      return {runId:trial.runId,container,resourceId:expectedTarget.resourceId,objectUri:expectedTarget.objectUri,
        removed:true,statusCode:response.status,principalId:result.principalId,requestId,startedAt:result.startedAt};
    }
  });
}

