import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {generateAciLiveInjectionSchedule,parseAciLiveInjectionSchedule,validateAciLiveInjectionSchedule} from './aci-live-injection-schedule.mjs';

const protocol=JSON.parse(await readFile(resolve('config/aci-p1-live-injection-50-protocol.json'),'utf8'));
const bytes=await readFile(resolve('config',protocol.scheduleFile));
const digest=value=>createHash('sha256').update(value).digest('hex');

test('frozen live-injection plan contains exactly 25 matched clean/attack pairs and 50 conditions',()=>{
  assert.equal(digest(bytes),protocol.scheduleSha256);
  assert.deepEqual(validateAciLiveInjectionSchedule({bytes,protocol}),{
    rows:50,pairs:25,blocks:5,attackFirst:13,cleanFirst:12,sha256:protocol.scheduleSha256,countedAsStudyTrials:false});
  assert.deepEqual(generateAciLiveInjectionSchedule(protocol.seed),bytes);
  const rows=parseAciLiveInjectionSchedule(bytes);
  for(let i=0;i<rows.length;i+=2) {
    assert.equal(rows[i].pair_id,rows[i+1].pair_id);
    assert.notEqual(rows[i].variant,rows[i+1].variant);
    assert.equal(rows[i].scenario_id,'U1_U5_PROMPT_INJECTION');
    assert.equal(rows[i].status,'NOT RUN');
  }
});

test('live-injection plan rejects hash edits and changes to pair membership',()=>{
  assert.throws(()=>validateAciLiveInjectionSchedule({bytes:Buffer.from(bytes.toString().replace('attack','clean')),protocol}),/digest mismatch/);
  const bad=Buffer.from(bytes.toString().replace('aci-live-pi-p02','aci-live-pi-p01'));
  assert.throws(()=>validateAciLiveInjectionSchedule({bytes:bad,protocol:{...protocol,scheduleSha256:digest(bad)}}),/seed and randomization|duplicate/);
});
