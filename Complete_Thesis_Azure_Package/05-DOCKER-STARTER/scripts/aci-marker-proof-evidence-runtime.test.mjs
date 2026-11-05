import test from 'node:test';
import assert from 'node:assert/strict';
import {createAciMarkerProofEvidenceRuntime,validateAciMarkerProofEvidenceConfig} from './aci-marker-proof-evidence-runtime.mjs';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const env=()=>({THESIS_EVIDENCE_BLOB_CONTAINER_URL:'https://evidenceacct.blob.core.windows.net/evidence',
  THESIS_EVIDENCE_CONTAINER_RESOURCE_ID:`/subscriptions/${id(1)}/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/evidenceacct/blobServices/default/containers/evidence`,
  THESIS_EVIDENCE_IDENTITY_CLIENT_ID:id(2),THESIS_EVIDENCE_PRINCIPAL_OBJECT_ID:id(3),
  THESIS_ACI_AUDIT_IDENTITY_CLIENT_ID:id(4),THESIS_ACI_AUDIT_PRINCIPAL_OBJECT_ID:id(5),
  THESIS_ACI_CONTROLLER_IDENTITY_CLIENT_ID:id(6),THESIS_EVIDENCE_RETENTION_APPROVED:'true',THESIS_EVIDENCE_RETENTION_DAYS:'365'});

test('composes separate managed writer, reader, and policy reader without network calls',()=>{
  const constructed=[];let networkCalls=0;
  class FakeCredential {constructor(options){constructed.push(options.clientId);} async getToken(){return {token:'unneeded-until-called'};}}
  const runtime=createAciMarkerProofEvidenceRuntime({env:env(),Credential:FakeCredential,fetchImpl:async()=>{networkCalls++;throw new Error('unexpected');}});
  assert.deepEqual(constructed,[id(2),id(4),id(6)]);
  assert.equal(runtime.observerPrincipalId,id(5));
  assert.equal(runtime.requiredRetentionDays,365);
  assert.equal(typeof runtime.persistMarkerContentProof,'function');
  assert.equal(typeof runtime.loadProtectedEvidence,'function');
  assert.equal(networkCalls,0);
});

test('requires institution approval, exact numeric retention, and distinct principals',()=>{
  assert.throws(()=>validateAciMarkerProofEvidenceConfig({...env(),THESIS_EVIDENCE_RETENTION_APPROVED:'false'}),/institutional retention approval or the exact owner-directed/);
  assert.throws(()=>validateAciMarkerProofEvidenceConfig({...env(),THESIS_EVIDENCE_RETENTION_DAYS:'365.5'}),/positive integer/);
  assert.throws(()=>validateAciMarkerProofEvidenceConfig({...env(),THESIS_ACI_AUDIT_PRINCIPAL_OBJECT_ID:id(3)}),/must be distinct/);
  assert.equal(validateAciMarkerProofEvidenceConfig(env()).minimumRetentionDays,365);
});

test('supports the exact owner-directed 400-study basis without asserting institutional approval',()=>{
  const retentionAuthority={basis:'owner_directed',scope:'aci_400_study_evidence_only',
    reference:'file:docs/ACI-400-OWNER-DIRECTED-RETENTION.md'};
  const configured={...env(),THESIS_EVIDENCE_RETENTION_APPROVED:'false',THESIS_EVIDENCE_RETENTION_DAYS:'146000'};
  assert.equal(validateAciMarkerProofEvidenceConfig(configured,retentionAuthority).retentionBasis,'owner_directed');
  assert.throws(()=>validateAciMarkerProofEvidenceConfig(configured,{...retentionAuthority,scope:'all_study_data'}),/institutional retention approval/);
  assert.throws(()=>validateAciMarkerProofEvidenceConfig({...configured,THESIS_EVIDENCE_RETENTION_DAYS:'365'},retentionAuthority),/146000-day period/);
  assert.equal(validateAciMarkerProofEvidenceConfig({...configured,THESIS_EVIDENCE_RETENTION_APPROVED:'true',THESIS_EVIDENCE_RETENTION_DAYS:'365'},retentionAuthority).retentionBasis,
    'institutional_approval_asserted_by_configuration');
});
