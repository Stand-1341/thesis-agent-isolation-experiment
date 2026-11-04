import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { generateAciP1DraftSchedule, validateAciP1DraftSchedule, ACI_DRAFT_SCENARIOS } from './aci-p1-pilot-draft-validator.mjs';

const seed = 'aci-p1-first50-draft-v1';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const protocolFor = bytes => ({
  status:'draft_not_approved', deployment:'azure_container_instances', profile:'P1', seed,
  scheduleSha256:digest(bytes), trials:50, blocks:5, scenariosPerBlock:10,
  countedAsStudyTrials:false, runPermitted:false,
  pendingScenarioAnalogs:{U6:{status:'prototype_integrated_not_azure_validated'},U8:{status:'prototype_integrated_not_azure_validated'}},
  blockers:['method approval','U6 analog','U8 analog']
});

test('generates a reproducible 50-row ACI P1 schedule with all ten scenarios in each shuffled block',()=>{
  const first=generateAciP1DraftSchedule(seed);
  assert.deepEqual(first,generateAciP1DraftSchedule(seed));
  const rows=first.toString('utf8').trimEnd().split('\n').slice(1).map(line=>line.split(','));
  assert.equal(rows.length,50);
  for(let block=1;block<=5;block++) {
    const blockRows=rows.filter(row=>Number(row[1])===block);
    assert.equal(blockRows.length,10);
    assert.deepEqual(new Set(blockRows.map(row=>row[5])),new Set(ACI_DRAFT_SCENARIOS));
    assert.deepEqual(blockRows.map(row=>Number(row[2])),Array.from({length:10},(_,i)=>i+1));
  }
  assert.ok(rows.every(row=>row[0].startsWith('pilot-aci-p1-')&&row[3]==='azure_container_instances'&&row[4]==='P1'));
  assert.equal(new Set(rows.map(row=>row[0])).size,50);
});

test('validates the first-50 structure and remains explicitly blocked from running',()=>{
  const bytes=generateAciP1DraftSchedule(seed);
  const result=validateAciP1DraftSchedule({bytes,protocol:protocolFor(bytes)});
  assert.deepEqual({status:result.status,runnable:result.runnable,counted:result.countedAsStudyTrials,
    rows:result.rows,blocks:result.blocks,unauthorized:result.unauthorized,legitimate:result.legitimate},
    {status:'draft_blocked_pending_method_approval_and_u6_u8_azure_validation',runnable:false,counted:false,
      rows:50,blocks:5,unauthorized:40,legitimate:10});
});

test('rejects changed schedule bytes, a missing U6/U8 gate, and any runnable metadata',()=>{
  const bytes=generateAciP1DraftSchedule(seed);
  const protocol=protocolFor(bytes);
  assert.throws(()=>validateAciP1DraftSchedule({bytes:Buffer.concat([bytes,Buffer.from('x')]),protocol}),/digest mismatch/);
  assert.throws(()=>validateAciP1DraftSchedule({bytes,protocol:{...protocol,pendingScenarioAnalogs:{...protocol.pendingScenarioAnalogs,U6:{status:'validated'}}}}),/remain explicitly unvalidated/);
  assert.throws(()=>validateAciP1DraftSchedule({bytes,protocol:{...protocol,runPermitted:true}}),/blocked draft, owner-approved pending validation/);
  assert.throws(()=>validateAciP1DraftSchedule({bytes,protocol:{...protocol,scheduleSha256:'0'.repeat(64)}}),/digest mismatch/);
});

test('checked-in draft metadata and schedule agree and preserve U6/U8 as unvalidated',async()=>{
  const protocol=JSON.parse(await readFile(new URL('../config/aci-p1-pilot-draft.json',import.meta.url),'utf8'));
  const bytes=await readFile(new URL('../../03-ACI-P1-PILOT-TRIAL-MATRIX-50-DRAFT.csv',import.meta.url));
  const result=validateAciP1DraftSchedule({bytes,protocol});
  assert.equal(result.runnable,false);
  assert.equal(result.status,'owner_approved_blocked_pending_validation');
  assert.ok(!result.blockers.some(item=>item.toLowerCase().includes('method approval')));
  assert.equal(protocol.pendingScenarioAnalogs.U6.status,'prototype_integrated_not_azure_validated');
  assert.equal(protocol.pendingScenarioAnalogs.U8.status,'prototype_integrated_not_azure_validated');
  for(const scenario of ['U6','U8']) {
    assert.equal(protocol.pendingScenarioAnalogs[scenario].candidateImplementation.status,'local_runtime_wiring_only_not_azure_validated');
    assert.equal(protocol.pendingScenarioAnalogs[scenario].candidateImplementation.azureValidated,false);
  }
  assert.equal(protocol.sourceMethod.methodAmendmentRequired,true);
});
