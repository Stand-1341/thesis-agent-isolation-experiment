import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isOwnerDirectedVmFunctionsRev5Idfix} from './run-experiment-cli.mjs';
import {applyRev5IdfixRetentionBasis} from './run-keyvault-vmfns-rev5-idfix-measured.mjs';

const approved={protocolRevision:'azure-proposed-v1-rev5-vm-functions-idfix',
  sha256:'2bd601c4de01900c318857901b36578b62fff95385f33f2e34a2c05b78a4bee5',trials:400,
  ownerDirection:{authorized:true,reference:'User instruction in this session to prepare a full 400-row VM/Functions-only plan after removing ACA and stopping ACI.'}};

test('Rev5 IDFIX owner retention requires the exact revision, matrix and authorized direction',()=>{
  assert.equal(isOwnerDirectedVmFunctionsRev5Idfix(approved),true);
  assert.equal(isOwnerDirectedVmFunctionsRev5Idfix({...approved,sha256:'0'.repeat(64)}),false);
  assert.equal(isOwnerDirectedVmFunctionsRev5Idfix({...approved,trials:399}),false);
  assert.equal(isOwnerDirectedVmFunctionsRev5Idfix({...approved,ownerDirection:{...approved.ownerDirection,authorized:false}}),false);
  assert.equal(isOwnerDirectedVmFunctionsRev5Idfix({...approved,ownerDirection:{...approved.ownerDirection,reference:'other'}}),false);
  assert.equal(isOwnerDirectedVmFunctionsRev5Idfix({...approved,protocolRevision:'azure-proposed-v1-rev4-vm-functions-only-draft'}),false);
});

test('Rev5 launcher overwrites inherited Rev4 retention metadata with only the Rev5 scope',()=>{
  const env=applyRev5IdfixRetentionBasis({THESIS_EVIDENCE_RETENTION_OWNER_APPROVAL_SCOPE:'rev4_owner_directed_measured_study',
    THESIS_EVIDENCE_RETENTION_OWNER_APPROVAL_REFERENCE:'file:docs/400-REV4-OWNER-DIRECTED-RETENTION.md'});
  assert.equal(env.THESIS_EVIDENCE_RETENTION_OWNER_APPROVED,'true');
  assert.equal(env.THESIS_EVIDENCE_RETENTION_OWNER_APPROVAL_SCOPE,'rev5_idfix_owner_directed_measured_study');
  assert.equal(env.THESIS_EVIDENCE_RETENTION_OWNER_APPROVAL_REFERENCE,'file:docs/400-REV5-IDFIX-OWNER-DIRECTED-RETENTION.md');
});
