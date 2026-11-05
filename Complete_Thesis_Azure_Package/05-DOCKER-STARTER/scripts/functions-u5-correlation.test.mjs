import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {prepareRunRequest} from '../functions/prepare-run-request.mjs';

test('Functions U5 route requires and preserves collector correlation',async()=>{
  const request={runId:'functions-p1-u5-run',scenario:'U5',u5Marker:'SYNTHETIC-marker',requestId:'u5-correlated-request-123'};
  assert.deepEqual(prepareRunRequest(request),request);
  assert.equal(prepareRunRequest({...request,requestId:undefined}),undefined);
  assert.equal(prepareRunRequest({...request,requestId:'bad'}),undefined);
  assert.deepEqual(prepareRunRequest({runId:'functions-p1-u1-run',scenario:'U1'}),
    {runId:'functions-p1-u1-run',scenario:'U1'});

  const route=await readFile(new URL('../functions/index.mjs',import.meta.url),'utf8');
  const packageScript=await readFile(new URL('./build-flex-package.ps1',import.meta.url),'utf8');
  assert.match(route,/const scenarioInput=prepareRunRequest\(data\)/);
  assert.match(route,/runScenario\(scenarioInput,/);
  assert.match(packageScript,/prepare-run-request\.mjs/);
});
