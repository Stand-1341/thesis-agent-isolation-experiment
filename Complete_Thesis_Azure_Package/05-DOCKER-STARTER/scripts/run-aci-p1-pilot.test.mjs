import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {inspectAciP1Readiness,runAciP1Pilot} from './run-aci-p1-pilot.mjs';

const protocol=JSON.parse(await readFile(new URL('../config/aci-p1-pilot-draft.json',import.meta.url),'utf8'));
const bytes=await readFile(new URL('../../03-ACI-P1-PILOT-TRIAL-MATRIX-50-DRAFT.csv',import.meta.url));

test('ACI draft preflight reports blocked and non-counted with the exact schedule hash',()=>{
  const result=inspectAciP1Readiness({bytes,protocol});
  assert.equal(result.runnable,false);
  assert.equal(result.countedAsStudyTrials,false);
  assert.equal(result.rows,50);
  assert.equal(result.sha256,protocol.scheduleSha256);
  assert.ok(result.blockers.some(item=>item.includes('U6')));
});

test('records the study-owner approval without marking unvalidated Azure gates as passed',async()=>{
  const readiness=JSON.parse(await readFile(new URL('../config/aci-p1-pilot-readiness.json',import.meta.url),'utf8'));
  const result=inspectAciP1Readiness({bytes,protocol,readiness});
  assert.equal(protocol.status,'owner_approved_pending_validation');
  assert.equal(readiness.approvals.status,'approved');
  assert.equal(readiness.gates.methodApproval.passed,true);
  assert.equal(result.runnable,false);
  assert.ok(!result.blockers.includes('protocol does not explicitly authorize this non-counted pilot'));
  assert.ok(result.blockers.includes('readiness gate u6Validated is not passed with an evidence reference'));
  assert.ok(result.blockers.includes('readiness gate u8Validated is not passed with an evidence reference'));
});

test('run refuses before loading dependencies or claiming a row when readiness is blocked',async()=>{
  let loaded=false;
  await assert.rejects(runAciP1Pilot({bytes,protocol,dependencies:async()=>{loaded=true;return {};}}),/ACI P1 pilot is blocked/);
  assert.equal(loaded,false);
});

test('readiness requires evidence references, U6/U8, approval, and exact schedule binding',()=>{
  const approvedProtocol={...protocol,status:'approved_for_non_counted_pilot',runPermitted:true,
    pendingScenarioAnalogs:{U6:{status:'validated',evidenceReference:'urn:test:u6'},U8:{status:'validated',evidenceReference:'urn:test:u8'}}};
  const gates=Object.fromEntries(['methodApproval','deploymentValidated','isolationValidated','verifierValidated',
    'independentEvidenceProtection','u6Validated','u8Validated','credentialsValidated']
    .map(name=>[name,{passed:true,evidenceReference:'urn:test:'+name}]));
  const readiness={approvals:{status:'approved',methodReference:'urn:test:method',approvedByReference:'urn:test:reviewer'},
    gates,scheduleSha256:protocol.scheduleSha256,countedAsStudyTrials:false};
  assert.equal(inspectAciP1Readiness({bytes,protocol:approvedProtocol,readiness}).runnable,true);
  assert.equal(inspectAciP1Readiness({bytes,protocol:approvedProtocol,readiness:{...readiness,scheduleSha256:'0'.repeat(64)}}).runnable,false);
  const withoutU8={...readiness,gates:{...gates,u8Validated:{passed:true}}};
  assert.equal(inspectAciP1Readiness({bytes,protocol:approvedProtocol,readiness:withoutU8}).runnable,false);
});

test('schedule mutation cannot pass preflight even if readiness binds the changed hash',()=>{
  const mutated=Buffer.from(bytes.toString().replace('NOT RUN','RUNNING'));
  assert.throws(()=>inspectAciP1Readiness({bytes:mutated,protocol}),/digest mismatch/);
});
