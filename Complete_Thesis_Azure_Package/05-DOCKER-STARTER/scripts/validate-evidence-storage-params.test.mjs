import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvidenceStorageParameters } from './validate-evidence-storage-params.mjs';

const ids = [
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000003',
];
const valid = {
  writerPrincipalId: { value: ids[0] },
  readerPrincipalId: { value: ids[1] },
  sessionRegistryReaderPrincipalId: { value: ids[2] },
  evidenceRetentionDays: { value: 365 },
};

test('accepts distinct verifier identities and explicit retention in ARM format', () => {
  assert.deepEqual(validateEvidenceStorageParameters(valid), {
    principalsDistinct: true,
    evidenceRetentionDays: 365,
    status: 'parameter_shape_only_effective_azure_permissions_unverified',
  });
});

test('rejects reusing writer identity as evidence verifier', () => {
  assert.throws(() => validateEvidenceStorageParameters({
    ...valid,
    readerPrincipalId: { value: ids[0] },
  }), /must be distinct/);
});

test('rejects reusing evidence verifier identity as session registry reader', () => {
  assert.throws(() => validateEvidenceStorageParameters({
    ...valid,
    sessionRegistryReaderPrincipalId: { value: ids[1] },
  }), /must be distinct/);
});

test('rejects malformed object IDs and missing or invalid retention', () => {
  assert.throws(() => validateEvidenceStorageParameters({ ...valid, writerPrincipalId: { value: 'writer' } }), /valid Entra object ID/);
  assert.throws(() => validateEvidenceStorageParameters({ ...valid, evidenceRetentionDays: { value: 0 } }), /at least 1 day/);
  assert.throws(() => validateEvidenceStorageParameters({ ...valid, evidenceRetentionDays: { value: '365' } }), /integer/);
});
