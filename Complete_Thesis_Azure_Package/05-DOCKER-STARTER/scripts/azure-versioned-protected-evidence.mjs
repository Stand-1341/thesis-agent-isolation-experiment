/** Version-bound protected Blob snapshot reader/writer for independent proof artifacts. */
import {randomUUID,createHash} from 'node:crypto';

const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTAINER_ID=/^\/subscriptions\/([0-9a-f-]{36})\/resourceGroups\/([A-Za-z0-9._()-]+)\/providers\/Microsoft\.Storage\/storageAccounts\/([a-z0-9]{3,24})\/blobServices\/default\/containers\/([a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9]))$/i;
const VERSION='2023-11-03';
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?
  Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const fingerprint=value=>`sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;

function parseOid(token) {
  const parts=String(token||'').split('.');
  if(parts.length!==3) return undefined;
  try {
    const claims=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));
    return GUID.test(claims.oid||'')?claims.oid.toLowerCase():undefined;
  } catch {return undefined;}
}
function secureBase(urlValue,resourceId) {
  const id=CONTAINER_ID.exec(resourceId||'');
  let url;try {url=new URL(urlValue);} catch {throw new Error('invalid protected evidence container URL');}
  if(!id||url.protocol!=='https:'||url.hostname!==`${id[3]}.blob.core.windows.net`||url.port||url.username||url.password||
    url.pathname!==`/${id[4]}`||url.search||url.hash) throw new Error('protected evidence URL does not match its container resource ID');
  return {url,subscription:id[1],resourceGroup:id[2],account:id[3],container:id[4]};
}
function lockedPolicy(body,minimumDays) {
  const props=body?.properties??body;
  const days=props?.immutabilityPeriodSinceCreationInDays;
  if(String(props?.state||'').toLowerCase()!=='locked'||!Number.isInteger(days)||days<minimumDays)
    throw new Error('protected evidence immutability policy is not locked for the required retention period');
  return {state:'Locked',retentionDays:days};
}

/**
 * Requires independently configured writer and reader identities. It does
 * not lock policies, enable versioning, or deploy Azure resources.
 */
export function createAzureVersionedProtectedEvidenceAdapter({containerUrl,containerResourceId,writerPrincipalId,readerPrincipalId,
  minimumRetentionDays,getWriterToken,getReaderToken,getManagementToken,fetchImpl=fetch,timeoutMs=15000}={}) {
  const base=secureBase(containerUrl,containerResourceId);
  if(!GUID.test(writerPrincipalId||'')||!GUID.test(readerPrincipalId||'')||writerPrincipalId.toLowerCase()===readerPrincipalId.toLowerCase()||
    !Number.isSafeInteger(minimumRetentionDays)||minimumRetentionDays<1||typeof getWriterToken!=='function'||
    typeof getReaderToken!=='function'||typeof getManagementToken!=='function'||typeof fetchImpl!=='function'||
    !Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>60000)
    throw new Error('versioned evidence adapter requires separate identities, explicit retention, and token/fetch callbacks');

  async function token(provider,expected,label) {
    let value;try {value=await provider();} catch {throw new Error(`${label} managed identity token unavailable`);}
    if(typeof value!=='string'||!value||/\r|\n/.test(value)||parseOid(value)!==expected.toLowerCase())
      throw new Error(`${label} token principal does not match its configured identity`);
    return value;
  }
  async function policy() {
    const auth=await getManagementToken();
    if(typeof auth!=='string'||!auth||/\r|\n/.test(auth)) throw new Error('evidence policy management token unavailable');
    const url=`https://management.azure.com${containerResourceId}/immutabilityPolicies/default?api-version=2025-08-01`;
    let response;try {response=await fetchImpl(url,{headers:{authorization:`Bearer ${auth}`},redirect:'error',signal:AbortSignal.timeout(timeoutMs)});}
    catch {throw new Error('protected evidence immutability policy could not be read');}
    if(!response.ok) throw new Error('protected evidence immutability policy could not be read');
    let body;try {body=await response.json();} catch {throw new Error('protected evidence immutability policy response is invalid');}
    return lockedPolicy(body,minimumRetentionDays);
  }
  async function blobFetch(url,method,identityToken,body) {
    const headers={authorization:`Bearer ${identityToken}`,'x-ms-version':VERSION,'x-ms-date':new Date().toUTCString()};
    if(method==='PUT') Object.assign(headers,{'x-ms-blob-type':'BlockBlob','content-type':'application/json','if-none-match':'*'});
    try {return await fetchImpl(url,{method,headers,...(body===undefined?{}:{body}),redirect:'error',signal:AbortSignal.timeout(timeoutMs)});}
    catch {throw new Error(`protected evidence Blob ${method} request failed`);}
  }
  function verifyBlobPolicyHeaders(response,stored) {
    const mode=response.headers.get('x-ms-immutability-policy-mode');
    const until=Date.parse(response.headers.get('x-ms-immutability-policy-until-date')||'');
    const writtenAt=Date.parse(stored?.writtenAt||'');
    if(String(mode||'').toLowerCase()!=='locked'||!Number.isFinite(until)||!Number.isFinite(writtenAt)||
      until<writtenAt+minimumRetentionDays*86400000)
      throw new Error('exact proof Blob version lacks a locked per-blob retention observation for the configured period');
  }
  function checkedReference(reference) {
    let url;try {url=new URL(reference);} catch {throw new Error('invalid protected evidence reference');}
    if(url.protocol!=='https:'||url.origin!==base.url.origin||!url.pathname.startsWith(`${base.url.pathname}/proofs/`)||
      url.hash||url.username||url.password||[...url.searchParams.keys()].some(key=>key!=='versionid')||
      url.searchParams.getAll('versionid').length!==1||url.searchParams.get('versionid').length>100||
      !/^[A-Za-z0-9_-]{1,150}-(?:U6|U8)-(?:marker|rbac|audit|lifecycle)-[a-f0-9-]{36}\.json$/i.test(url.pathname.split('/').at(-1))||
      !url.searchParams.get('versionid')) throw new Error('protected evidence reference is outside the versioned proof namespace');
    return url;
  }
  async function writeProtectedSnapshot({snapshot,observerPrincipalId}={}) {
      const artifact=snapshot?.schema==='azure_blob_marker_content_proof_v1'?'marker':
        snapshot?.schema==='azure-effective-blob-access-review-v1'?'rbac':
        snapshot?.schema==='azure_storage_blob_audit_snapshot_v1'?'audit':
        snapshot?.schema==='azure_aci_arm_activity_snapshot_v1'?'lifecycle':undefined;
      if(!snapshot||!artifact||!['U6','U8'].includes(snapshot.scenario)||
        observerPrincipalId?.toLowerCase()!==readerPrincipalId.toLowerCase())
        throw new Error('unsupported protected evidence snapshot or independent observer identity');
      const retention=await policy();
      const tokenValue=await token(getWriterToken,writerPrincipalId,'evidence writer');
      const leaf=`${snapshot.runId}-${snapshot.scenario}-${artifact}-${randomUUID()}.json`;
      const url=new URL(`${base.url.href.replace(/\/$/,'')}/proofs/${leaf}`);
      // Reserve space for Azure's opaque version ID and its URL encoding under
      // the independent verifier's 290-character reference limit.
      if(url.href.length+60>290) throw new Error("marker proof reference would exceed the verifier's maximum length");
      const snapshotFingerprint=fingerprint(snapshot);
      const writtenAt=new Date().toISOString();
      let response=await blobFetch(url,'PUT',tokenValue,JSON.stringify({snapshot,snapshotFingerprint,writtenAt}));
      if(response.status===409||response.status===412) throw new Error('protected evidence object already exists');
      if(!response.ok) throw new Error(`protected evidence Blob PUT returned HTTP ${response.status}`);
      const versionId=response.headers.get('x-ms-version-id');
      if(typeof versionId!=='string'||!versionId||/[\r\n]/.test(versionId))
        throw new Error('Azure did not return a Blob version ID; proof reference cannot be independently pinned');
      const reference=new URL(url.href);reference.searchParams.set('versionid',versionId);
      return {reference:reference.href,versionId,retentionPolicyState:retention.state,retentionDays:retention.retentionDays};
  }
  return Object.freeze({
    writeProtectedEvidence:args=>writeProtectedSnapshot(args),
    writeProtectedSnapshot,
    async loadProtectedEvidence({reference,observerPrincipalId}={}) {
      if(observerPrincipalId?.toLowerCase()!==readerPrincipalId.toLowerCase())
        throw new Error('protected evidence load must use the configured independent reader principal');
      const url=checkedReference(reference),retention=await policy();
      const tokenValue=await token(getReaderToken,readerPrincipalId,'evidence reader');
      const response=await blobFetch(url,'GET',tokenValue);
      if(!response.ok) throw new Error(`protected evidence Blob GET returned HTTP ${response.status}`);
      const versionId=response.headers.get('x-ms-version-id');
      if(versionId!==url.searchParams.get('versionid')) throw new Error('Azure returned a different version than the pinned evidence version');
      let stored;try {stored=await response.json();} catch {throw new Error('protected evidence snapshot is invalid JSON');}
      verifyBlobPolicyHeaders(response,stored);
      if(!stored?.snapshot||stored.snapshotFingerprint!==fingerprint(stored.snapshot)) throw new Error('protected evidence snapshot hash mismatch');
      return {reference:url.href,readerPrincipalId:readerPrincipalId.toLowerCase(),immutable:true,
        retentionPolicyState:retention.state,retentionDays:retention.retentionDays,versionId,snapshot:stored.snapshot,
        snapshotFingerprint:stored.snapshotFingerprint};
    }
  });
}

export {fingerprint as fingerprintProtectedEvidenceSnapshot,lockedPolicy as assertVersionedEvidenceRetentionPolicy};
