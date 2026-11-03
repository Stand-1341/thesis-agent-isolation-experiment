import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {saveEvidence,readEvidence} from './evidence-store.mjs';

test('evidence round trips, refuses overwrite and detects alteration',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'thesis-evidence-'));
  try {
    const record={runId:'test-run-1',classification:'indeterminate'};
    const path=await saveEvidence(dir,record);
    assert.deepEqual(await readEvidence(path),record);
    await assert.rejects(saveEvidence(dir,record),{code:'EEXIST'});
    const envelope=JSON.parse(await readFile(path,'utf8'));
    envelope.payload=JSON.stringify({...record,classification:'unauthorized_success'});
    await writeFile(path,JSON.stringify(envelope));
    await assert.rejects(readEvidence(path),/integrity/);
    await assert.rejects(saveEvidence(dir,{runId:'../escape'}),/invalid/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
