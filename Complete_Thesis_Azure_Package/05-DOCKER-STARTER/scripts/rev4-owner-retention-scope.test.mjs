import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isOwnerDirectedVmFunctionsRev4} from './run-experiment-cli.mjs';

const approved={protocolRevision:'azure-proposed-v1-rev4-vm-functions-only-draft',
  sha256:'2ecce88dab8e7a61fa457ee6e27e5c6551a0035528aacd51d6e7502c6c0b0abe',trials:400,
  ownerDirection:{authorized:true,reference:'User instruction in this session to prepare a full 400-row VM/Functions-only plan after removing ACA and stopping ACI.'}};

test('rev4 VM/Functions owner retention requires the exact authorized protocol revision and matrix',()=>{
  assert.equal(isOwnerDirectedVmFunctionsRev4(approved),true);
  assert.equal(isOwnerDirectedVmFunctionsRev4({...approved,sha256:'0'.repeat(64)}),false);
  assert.equal(isOwnerDirectedVmFunctionsRev4({...approved,trials:399}),false);
  assert.equal(isOwnerDirectedVmFunctionsRev4({...approved,ownerDirection:{...approved.ownerDirection,authorized:false}}),false);
  assert.equal(isOwnerDirectedVmFunctionsRev4({...approved,ownerDirection:{...approved.ownerDirection,reference:'other'}}),false);
  assert.equal(isOwnerDirectedVmFunctionsRev4({...approved,protocolRevision:'azure-proposed-v1-rev4-aci-draft'}),false);
});
