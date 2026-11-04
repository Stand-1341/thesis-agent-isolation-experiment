import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createAciBlobMarkerContentProofPersister,fingerprintAciMarkerProofSnapshot} from './aci-blob-marker-content-proof.mjs';

const observer='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const source='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const verifier='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const probeId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const body=Buffer.from(JSON.stringify({marker:`SYNTHETIC-${'a'.repeat(64)}`}));
const contentFingerprint=`sha256:${createHash('sha256').update(body).digest('hex')}`;
const ts='2026-11-04T12:00:00.000Z';
const capture=(requestId,principalId,statusCode)=>({bodyBytes:body,statusCode,requestId,principalId,
  capturedAt:ts,captureBoundary:'direct_http_response'});
function fixture({probeStatusCode=403,probeBody=false}={}) {
  const input={runId:'u6-proof-run',scenario:'U6',resourceId:'/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/r/providers/Microsoft.Storage/storageAccounts/store/blobServices/default/containers/session-b',
    objectUri:'https://store.blob.core.windows.net/session-b/u6-proof-run.json',markerFingerprint:contentFingerprint,
    sourcePrincipalId:source,verifierPrincipalId:verifier,probePrincipalId:probeId,
    seed:{requestId:'aci-put-1234567890',principalId:source,capture:capture('aci-put-1234567890',source,201)},
    independentRead:{requestId:'aci-verifier-get-1234567890',principalId:verifier,capture:capture('aci-verifier-get-1234567890',verifier,200)},
    probe:{requestId:'aci-probe-get-1234567890',principalId:probeId,statusCode:probeStatusCode,
      ...(probeBody?{capture:capture('aci-probe-get-1234567890',probeId,200)}:{observedAt:ts})}};
  let persisted;
  const persist=createAciBlobMarkerContentProofPersister({observerPrincipalId:observer,requiredRetentionDays:180,
    writeProtectedEvidence:async({snapshot})=>{persisted=snapshot;return {reference:'https://evidence.example.test/marker/u6-proof-run'};},
    loadProtectedEvidence:async({reference})=>({reference,readerPrincipalId:observer,immutable:true,retentionPolicyState:'Locked',
      retentionDays:365,versionId:'version-001',snapshot:persisted,snapshotFingerprint:fingerprintAciMarkerProofSnapshot(persisted)})});
  return {input,persist,persisted:()=>persisted};
}
test('persists a no-content proof for an audited 403 probe and returns verifier envelope',async()=>{
  const {input,persist,persisted}=fixture();
  const result=await persist(input);
  assert.deepEqual(Object.keys(result).sort(),['evidenceReference','snapshotFingerprint']);
  assert.equal(result.evidenceReference,'https://evidence.example.test/marker/u6-proof-run');
  assert.equal(persisted().schema,'azure_blob_marker_content_proof_v1');
  assert.equal(persisted().seed.contentFingerprint,input.markerFingerprint);
  assert.equal(persisted().independentRead.contentFingerprint,input.markerFingerprint);
  assert.equal(persisted().probe.statusCode,403);
  assert.equal('contentFingerprint' in persisted().probe,false);
  assert.equal('marker' in persisted(),false);
});

test('requires the 200 probe response body to match the marker bytes',async()=>{
  const {input,persist}=fixture({probeStatusCode:200,probeBody:true});
  const result=await persist(input);
  assert.equal(result.snapshotFingerprint.startsWith('sha256:'),true);
});

test('fails closed on a different probe body or absent direct response capture',async()=>{
  const different=fixture({probeStatusCode:200,probeBody:true});
  const other=Buffer.from(JSON.stringify({marker:`SYNTHETIC-${'b'.repeat(64)}`}));
  different.input.probe.capture.bodyBytes=other;
  await assert.rejects(different.persist(different.input),/differs from the seeded marker/);
  const absent=fixture({probeStatusCode:200});
  await assert.rejects(absent.persist(absent.input),/provenance or response identity/);
});

test('rejects evidence store round trips without locked retention and identity provenance',async()=>{
  const {input}=fixture();
  const persist=createAciBlobMarkerContentProofPersister({observerPrincipalId:observer,requiredRetentionDays:180,
    writeProtectedEvidence:async()=>({reference:'https://evidence.example.test/marker/run'}),
    loadProtectedEvidence:async({reference})=>({reference,readerPrincipalId:observer,immutable:false,
      retentionPolicyState:'Unlocked',retentionDays:0,versionId:'v',snapshot:{},snapshotFingerprint:'sha256:bad'})});
  await assert.rejects(persist(input),/immutable-retention or round-trip integrity/);
});
