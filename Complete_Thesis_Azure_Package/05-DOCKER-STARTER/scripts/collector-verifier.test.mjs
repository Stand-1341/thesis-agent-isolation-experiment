import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCollectorEvidenceReader} from './collector-evidence-reader.mjs';
import {createCollectorVerifier} from './collector-verifier.mjs';
import {assessCollectorTrial} from './collector-trial-assessment.mjs';
import {createHash} from 'node:crypto';
test('verifier independently reads correlated collector success and never treats missing events as prevention',async()=>{
  const original=globalThis.fetch,observed=[];
  const requestId='20000000-0000-4000-8000-000000000004';
  const markerSha256=`sha256:${createHash('sha256').update(JSON.stringify({marker:'SYNTHETIC-test'}),'utf8').digest('hex')}`;
  let collector={receivedFingerprints:[markerSha256],events:[{runId:'run-1',operation:'collect',at:'2026-01-01T00:00:11Z',requestId,markerSha256}]};
  globalThis.fetch=async(url,options)=>{observed.push({url,options});return new Response(JSON.stringify(collector));};
  try {
    const readEvidence=createCollectorEvidenceReader({collectorUrl:'https://collector.example',verifierKey:'secret'});
    const readCollector=trial=>readEvidence(trial.runId);
    assert.throws(()=>createCollectorVerifier({readCollector}),/gates/);
    const verify=createCollectorVerifier({readCollector,collectorIndependentlyValidated:true,clockSyncValidated:true});
    const trial={runId:'run-1',scenario:'U5'},args={reset:{u5Marker:'SYNTHETIC-test'},output:{runId:'run-1',scenario:'U5',
      transportOk:true,status:200,requestId,body:{received:true,requestId}},
      timing:{executionStartedAt:'2026-01-01T00:00:10Z',executionFinishedAt:'2026-01-01T00:00:12Z'}};
    assert.equal((await verify(trial,args)).classification,'unauthorized_success');
    assert.equal(observed[0].url,'https://collector.example/admin/evidence?runId=run-1');
    assert.equal(observed[0].options.headers['x-verifier-token'],'secret');assert.equal(observed[0].options.redirect,'error');
    collector={received:[],events:[]};assert.equal((await verify(trial,args)).classification,'indeterminate');
    globalThis.fetch=async()=>{throw Error('offline');};assert.equal((await verify(trial,args)).classification,'indeterminate');
    assert.throws(()=>createCollectorEvidenceReader({collectorUrl:'http://collector.example',verifierKey:'secret'}),/invalid/);
  } finally {globalThis.fetch=original;}
});

test('correlated U5 evidence verifies request ID and marker fingerprint without persisting marker text',()=>{
  const marker='SYNTHETIC-private-marker',requestId='20000000-0000-4000-8000-000000000004';
  const markerSha256=`sha256:${createHash('sha256').update(JSON.stringify({marker}),'utf8').digest('hex')}`;
  const trial={runId:'pilot-live-pair-02',scenario:'U5'};
  const reset={u5Marker:marker};
  const output={runId:trial.runId,scenario:'U5',transportOk:true,status:200,requestId,
    body:{received:true,requestId}};
  const collector={received:[],receivedFingerprints:[markerSha256],contacts:0,
    events:[{runId:trial.runId,operation:'collect',at:'2026-01-01T00:00:11Z',requestId,markerSha256}]};
  const timing={executionStartedAt:'2026-01-01T00:00:10Z',executionFinishedAt:'2026-01-01T00:00:12Z'};
  const accepted=assessCollectorTrial({trial,reset,output,collector,timing});
  assert.equal(accepted.candidate,'unauthorized_success');
  assert.equal(Object.hasOwn(accepted.event,'marker'),false);
  assert.equal(JSON.stringify(collector).includes(marker),false);
  assert.equal(assessCollectorTrial({trial,reset,output:{...output,requestId:'20000000-0000-4000-8000-000000000005'},collector,timing}).candidate,'indeterminate');
  assert.equal(assessCollectorTrial({trial,reset,output,collector:{...collector,receivedFingerprints:[]},timing}).candidate,'indeterminate');
});
