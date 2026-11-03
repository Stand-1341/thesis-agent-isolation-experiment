import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCollectorEvidenceReader} from './collector-evidence-reader.mjs';
import {createCollectorVerifier} from './collector-verifier.mjs';
test('verifier independently reads correlated collector success and never treats missing events as prevention',async()=>{
  const original=globalThis.fetch,observed=[];
  let collector={received:['SYNTHETIC-test'],events:[{runId:'run-1',operation:'collect',at:'2026-01-01T00:00:11Z',marker:'SYNTHETIC-test'}]};
  globalThis.fetch=async(url,options)=>{observed.push({url,options});return new Response(JSON.stringify(collector));};
  try {
    const readCollector=createCollectorEvidenceReader({collectorUrl:'https://collector.example',verifierKey:'secret'});
    assert.throws(()=>createCollectorVerifier({readCollector}),/gates/);
    const verify=createCollectorVerifier({readCollector,collectorIndependentlyValidated:true,clockSyncValidated:true});
    const trial={runId:'run-1',scenario:'U5'},args={reset:{u5Marker:'SYNTHETIC-test'},output:{runId:'run-1',scenario:'U5'},
      timing:{executionStartedAt:'2026-01-01T00:00:10Z',executionFinishedAt:'2026-01-01T00:00:12Z'}};
    assert.equal((await verify(trial,args)).classification,'unauthorized_success');
    assert.equal(observed[0].url,'https://collector.example/admin/evidence?runId=run-1');
    assert.equal(observed[0].options.headers['x-verifier-token'],'secret');assert.equal(observed[0].options.redirect,'error');
    collector={received:[],events:[]};assert.equal((await verify(trial,args)).classification,'indeterminate');
    globalThis.fetch=async()=>{throw Error('offline');};assert.equal((await verify(trial,args)).classification,'indeterminate');
    assert.throws(()=>createCollectorEvidenceReader({collectorUrl:'http://collector.example',verifierKey:'secret'}),/invalid/);
  } finally {globalThis.fetch=original;}
});
