import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateAciEvidenceReadiness,createAciEvidenceVerifier} from './aci-evidence-readiness.mjs';

const ids=['00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004'];
const proof=()=>({passed:true,runId:'10000000-0000-0000-0000-000000000001',
  observedAt:'2026-11-04T12:00:00Z',resourceId:'/subscriptions/test/resource'});
const ready={workloadPrincipalId:ids[0],evidenceWriterPrincipalId:ids[1],verifierPrincipalId:ids[2],auditReaderPrincipalId:ids[3],
  observations:{lockedRetention:{...proof(),retentionDays:365},independentReadback:proof(),overwriteDenied:proof(),deleteDenied:proof(),auditAttribution:proof()}};

test('ACI evidence gate accepts distinct identities and complete externally observed evidence',()=>{
  assert.deepEqual(validateAciEvidenceReadiness(ready),{ready:true,identitySeparation:'asserted_by_supplied_ids',
    retentionDays:365,evidence:'externally_observed_preflight_required',azureValidated:false});
});
test('ACI evidence gate rejects shared identities',()=>{
  assert.throws(()=>validateAciEvidenceReadiness({...ready,verifierPrincipalId:ids[0]}),/must be distinct/);
});
test('ACI evidence gate rejects missing or malformed immutable evidence observations',()=>{
  assert.throws(()=>validateAciEvidenceReadiness({...ready,observations:{...ready.observations,deleteDenied:undefined}}),/deletion denial/);
  assert.throws(()=>validateAciEvidenceReadiness({...ready,observations:{...ready.observations,
    lockedRetention:{...proof(),retentionDays:0}}}),/retention period/);
});
test('ACI verifier refuses pilot bypass and unvalidated Azure assertions',()=>{
  const base={readAudit:async()=>[],principalForTrial:()=>ids[0],blobEndpoint:'https://x.blob.core.windows.net/c',
    blobResourceId:'/subscriptions/x/resourceGroups/r/providers/Microsoft.Storage/storageAccounts/abc/blobServices/default/containers/c',
    workspaceId:'00000000-0000-0000-0000-000000000001',readiness:ready};
  assert.throws(()=>createAciEvidenceVerifier({...base,pilotMode:true}),/pilotMode/);
  assert.throws(()=>createAciEvidenceVerifier(base),/validation gates/);
});
