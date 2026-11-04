/**
 * Builds and persists the protected marker-content observation required by
 * the independent U6/U8 verifier. This module performs no Azure calls. Capture
 * functions must supply bytes observed at the actual PUT/GET response boundary
 * under independently attributable principals; caller-echoed fingerprints
 * are never accepted as a substitute.
 */
import {createHash} from 'node:crypto';

const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN=/^[A-Za-z0-9_-]{1,150}$/;
const REQUEST=/^[A-Za-z0-9._:-]{12,150}$/;
const REF=/^(https:\/\/|urn:|file:)[^\r\n]{1,290}$/i;
const MARKER=/^SYNTHETIC-[a-f0-9]{64}$/;

function canonical(value) {
  if(Array.isArray(value)) return value.map(canonical);
  if(value&&typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
function hashBytes(value) {return `sha256:${createHash('sha256').update(value).digest('hex')}`;}
function hashSnapshot(value) {return hashBytes(JSON.stringify(canonical(value)));}
function parseCapture(capture,label) {
  if(!capture||!Buffer.isBuffer(capture.bodyBytes)) throw new Error(`${label} must provide actual response body bytes captured at the HTTP boundary`);
  let body;
  try {body=JSON.parse(capture.bodyBytes.toString('utf8'));} catch {throw new Error(`${label} body is not valid marker JSON`);}
  if(!body||typeof body.marker!=='string'||!MARKER.test(body.marker)||
    capture.bodyBytes.toString('utf8')!==JSON.stringify({marker:body.marker}))
    throw new Error(`${label} body is not the exact synthetic marker payload`);
  return hashBytes(capture.bodyBytes);
}
function validateCapture(capture,{label,status,requestId,principalId,boundary}) {
  if(!capture||capture.statusCode!==status||capture.requestId!==requestId||capture.principalId?.toLowerCase()!==principalId.toLowerCase()||
    capture.captureBoundary!==boundary||!Number.isFinite(Date.parse(capture.capturedAt)))
    throw new Error(`${label} content capture provenance or response identity is incomplete`);
  return parseCapture(capture,label);
}

/**
 * @param {{observerPrincipalId:string,requiredRetentionDays:number,
 * writeProtectedEvidence:(args:{snapshot:object,observerPrincipalId:string})=>Promise<object>,
 * loadProtectedEvidence:(args:{reference:string,observerPrincipalId:string})=>Promise<object>}} options
 */
export function createAciBlobMarkerContentProofPersister({observerPrincipalId,requiredRetentionDays=180,
  writeProtectedEvidence,loadProtectedEvidence}={}) {
  if(!GUID.test(observerPrincipalId||'')||!Number.isInteger(requiredRetentionDays)||requiredRetentionDays<1||
    typeof writeProtectedEvidence!=='function'||typeof loadProtectedEvidence!=='function')
    throw new Error('marker-content proof persister requires an independent observer and protected evidence writer/reader');

  return async function persistAciBlobMarkerContentProof(input) {
    const {runId,scenario,resourceId,objectUri,markerFingerprint,sourcePrincipalId,verifierPrincipalId,probePrincipalId,
      seed,independentRead,probe}=input||{};
    if(!RUN.test(runId||'')||!['U6','U8'].includes(scenario)||typeof resourceId!=='string'||!resourceId.startsWith('/')||
      typeof objectUri!=='string'||!/^https:\/\/[a-z0-9]{3,24}\.blob\.core\.windows\.net\/[a-z0-9-]+\/[A-Za-z0-9_-]{1,150}\.json$/i.test(objectUri)||
      !/^sha256:[a-f0-9]{64}$/i.test(markerFingerprint||'')||![sourcePrincipalId,verifierPrincipalId,probePrincipalId].every(value=>GUID.test(value||''))||
      new Set([sourcePrincipalId,verifierPrincipalId,probePrincipalId].map(value=>value.toLowerCase())).size!==3)
      throw new Error('invalid marker proof run, target, fingerprint, or separated principals');
    for(const [label,event] of [['seed',seed],['independentRead',independentRead],['probe',probe]]) {
      if(!REQUEST.test(event?.requestId||'')||!GUID.test(event?.principalId||'')) throw new Error(`${label} request correlation is missing`);
    }
    if(new Set([seed.requestId,independentRead.requestId,probe.requestId]).size!==3||
      seed.principalId.toLowerCase()!==sourcePrincipalId.toLowerCase()||
      independentRead.principalId.toLowerCase()!==verifierPrincipalId.toLowerCase()||
      probe.principalId.toLowerCase()!==probePrincipalId.toLowerCase())
      throw new Error('marker proof request IDs or principal bindings are inconsistent');
    if(!GUID.test(observerPrincipalId)||[sourcePrincipalId,verifierPrincipalId,probePrincipalId].some(id=>id.toLowerCase()===observerPrincipalId.toLowerCase()))
      throw new Error('independent content observer must be distinct from all operation principals');

    const seedHash=validateCapture(seed.capture,{label:'seed',status:201,requestId:seed.requestId,
      principalId:sourcePrincipalId,boundary:'blob_request_body'});
    const readHash=validateCapture(independentRead.capture,{label:'independent read',status:200,requestId:independentRead.requestId,
      principalId:verifierPrincipalId,boundary:'blob_response_body'});
    if(seedHash!==markerFingerprint||readHash!==markerFingerprint)
      throw new Error('seed or independent read content does not match the expected marker fingerprint');
    if(![200,403].includes(probe.statusCode)) throw new Error('probe marker observation must be HTTP 200 or 403');
    let probeHash;
    if(probe.statusCode===200) {
      probeHash=validateCapture(probe.capture,{label:'probe',status:200,requestId:probe.requestId,
        principalId:probePrincipalId,boundary:'blob_response_body'});
      if(probeHash!==markerFingerprint) throw new Error('probe returned content differs from the seeded marker');
    } else if(probe.capture!==undefined) {
      throw new Error('403 probe must not claim marker response content');
    }

    const snapshot={schema:'azure_blob_marker_content_proof_v1',runId,scenario,resourceId,objectUri,markerFingerprint,
      capturedByPrincipalId:observerPrincipalId.toLowerCase(),
      seed:{requestId:seed.requestId,principalId:sourcePrincipalId.toLowerCase(),statusCode:201,contentFingerprint:seedHash,
        capturedAt:seed.capture.capturedAt},
      independentRead:{requestId:independentRead.requestId,principalId:verifierPrincipalId.toLowerCase(),statusCode:200,
        contentFingerprint:readHash,capturedAt:independentRead.capture.capturedAt},
      probe:{requestId:probe.requestId,principalId:probePrincipalId.toLowerCase(),statusCode:probe.statusCode,
        ...(probeHash?{contentFingerprint:probeHash}:{}),capturedAt:probe.statusCode===200?probe.capture.capturedAt:probe.observedAt}};
    if(!Number.isFinite(Date.parse(snapshot.probe.capturedAt))) throw new Error('probe observation time is missing or invalid');
    const snapshotFingerprint=hashSnapshot(snapshot);
    let written;
    try {written=await writeProtectedEvidence({snapshot,observerPrincipalId});}
    catch {throw new Error('protected marker-content proof write failed');}
    const reference=written?.reference;
    if(!REF.test(reference||'')) throw new Error('protected evidence writer returned no valid marker proof reference');
    let stored;
    try {stored=await loadProtectedEvidence({reference,observerPrincipalId});}
    catch {throw new Error('protected marker-content proof could not be independently reloaded');}
    if(!stored||stored.reference!==reference||stored.readerPrincipalId?.toLowerCase()!==observerPrincipalId.toLowerCase()||
      stored.immutable!==true||stored.retentionPolicyState!=='Locked'||stored.retentionDays<requiredRetentionDays||
      typeof stored.versionId!=='string'||!stored.versionId||stored.snapshotFingerprint!==snapshotFingerprint||
      hashSnapshot(stored.snapshot)!==snapshotFingerprint||JSON.stringify(canonical(stored.snapshot))!==JSON.stringify(canonical(snapshot)))
      throw new Error('persisted marker-content proof failed immutable-retention or round-trip integrity validation');
    return {evidenceReference:reference,snapshotFingerprint};
  };
}

export {hashSnapshot as fingerprintAciMarkerProofSnapshot};
