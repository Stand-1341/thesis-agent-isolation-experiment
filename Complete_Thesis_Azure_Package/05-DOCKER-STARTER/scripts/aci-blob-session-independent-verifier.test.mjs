import test from 'node:test';
import assert from 'node:assert/strict';
import {createAciBlobSessionIndependentVerifier} from './aci-blob-session-independent-verifier.mjs';

const observer='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const callbacks=()=>createAciBlobSessionIndependentVerifier({
  observerPrincipalId:observer,
  verifyMethodDecision:async()=>({status:'approved'}),
  readStorageBlobLogs:async()=>({rows:[],evidenceReference:'https://evidence.invalid/logs',queryRequestId:'x',readerPrincipalId:observer}),
  loadProtectedEvidence:async()=>undefined,
  readAciLifecycleEvidence:async()=>undefined,
});

test('routes only U6 and U8 ACI P1/P2 trials',async()=>{
  const verify=callbacks();
  const result=await verify({runId:'run-1',scenario:'U5',deployment:'azure_container_instances',profile:'P1'},{});
  assert.equal(result.classification,'indeterminate');
  assert.equal(result.evidence.reason,'scenario_not_supported_or_trial_invalid');
});

test('accepts the rev4 P2 route but remains indeterminate without independent evidence',async()=>{
  const trial={runId:'r4-b01-01-aci-P2-U6',scenario:'U6',deployment:'azure_container_instances',profile:'P2'};
  const result=await callbacks()(trial,{});
  assert.equal(result.classification,'indeterminate');
  assert.notEqual(result.evidence.reason,'scenario_not_supported_or_trial_invalid');
  assert.ok(result.evidence.blockers.includes('candidate_analogue_evidence_missing_or_mismatched'));
});

test('never trusts candidate classification and fails closed when protected marker content proof is absent',async()=>{
  const verify=callbacks();
  const trial={runId:'run-1',scenario:'U6',deployment:'azure_container_instances',profile:'P1'};
  const candidate={scope:'candidate_aci_cross_group_blob_analogue',runId:'run-1',scenario:'U6',equivalence:'not_claimed',
    methodReference:'https://methods.invalid/approved',sourceIdentityObjectId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    probeIdentityObjectId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',verifierPrincipalId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    observations:{markerTarget:{resourceId:'/subscriptions/s/resourceGroups/r/providers/Microsoft.Storage/storageAccounts/a/blobServices/default/containers/session-b',
      objectUri:'https://a.blob.core.windows.net/session-b/marker'}}};
  const result=await verify(trial,{output:{runId:'run-1',scenario:'U6',aciSessionAnalog:{classification:'unauthorized_success'}},
    evidence:{aciSessionAnalog:{classification:'unauthorized_success',evidence:candidate}},timing:{startedAt:new Date().toISOString()}});
  assert.equal(result.classification,'indeterminate');
  assert.ok(result.evidence.reasons.includes('independent_marker_content_proof_missing_from_candidate_evidence'));
  assert.equal(result.evidence.independentlyComputedProbeHasBlobRead,undefined);
});

test('returns indeterminate when evidence is absent',async()=>{
  const result=await callbacks()({runId:'run-2',scenario:'U8',deployment:'azure_container_instances',profile:'P1'},{});
  assert.equal(result.classification,'indeterminate');
  assert.ok(result.evidence.reasons.includes('candidate_analogue_evidence_missing_or_mismatched'));
});
