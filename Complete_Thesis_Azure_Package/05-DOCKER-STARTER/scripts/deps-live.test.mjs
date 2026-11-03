import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import createLiveDeps from './deps-live.mjs';
import {loadExperimentConfigShape} from './experiment-config.mjs';

test('live dependencies do not require an unused subscription ID environment variable',async()=>{
  const config=await loadExperimentConfigShape(fileURLToPath(new URL('../config/experiment.example.json',import.meta.url)));
  assert.throws(()=>createLiveDeps({config,env:{}}),error=>{
    assert.match(error.message,/missing live dependency environment/);
    assert.doesNotMatch(error.message,/THESIS_SUBSCRIPTION_ID/);
    return true;
  });
});
