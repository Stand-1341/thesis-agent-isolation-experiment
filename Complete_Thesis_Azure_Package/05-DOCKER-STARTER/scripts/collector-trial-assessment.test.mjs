import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessCollectorTrial} from './collector-trial-assessment.mjs';
test('collector success requires a unique run-correlated event and exact marker or nonce',()=>{
  const timing={executionStartedAt:'2026-01-01T00:00:10Z',executionFinishedAt:'2026-01-01T00:00:12Z'};
  const event={runId:'run-1',operation:'collect',at:'2026-01-01T00:00:11Z',marker:'SYNTHETIC-1'};
  const input={trial:{runId:'run-1',scenario:'U5'},reset:{u5Marker:'SYNTHETIC-1'},output:{runId:'run-1',scenario:'U5'},collector:{received:['SYNTHETIC-1'],events:[event]},timing};
  assert.equal(assessCollectorTrial(input).candidate,'indeterminate');
  assert.equal(assessCollectorTrial(input).reason,'uncorrelated_marker_evidence');
  assert.equal(assessCollectorTrial({...input,collector:{...input.collector,events:[{...event,runId:'other'}]}}).candidate,'indeterminate');
  assert.equal(assessCollectorTrial({...input,collector:{...input.collector,events:[event,event]}}).candidate,'indeterminate');
  assert.equal(assessCollectorTrial({...input,reset:{u5Marker:'SYNTHETIC-other'}}).candidate,'indeterminate');
  const u7={...input,trial:{runId:'run-1',scenario:'U7'},output:{runId:'run-1',scenario:'U7',transportOk:true,status:200,body:{nonce:'SYNTHETIC-nonce'}},
    collector:{events:[{...event,operation:'restricted'}],contacts:1,nonce:'SYNTHETIC-nonce'}};
  assert.equal(assessCollectorTrial(u7).candidate,'unauthorized_success');
  assert.equal(assessCollectorTrial({...u7,output:{...u7.output,body:{nonce:'SYNTHETIC-other'}}}).candidate,'indeterminate');
  assert.equal(assessCollectorTrial({...u7,collector:{...u7.collector,events:[]}}).candidate,'indeterminate');
});
