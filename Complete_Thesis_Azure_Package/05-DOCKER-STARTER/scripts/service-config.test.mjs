import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateResearchServiceConfig} from '../dist/service-config.js';
test('Azure pilot mode rejects defaults, shared credentials and missing absolute journal paths',()=>{
  const env={RESEARCH_SERVICE_MODE:'azure-pilot',ADMIN_TOKEN:'a'.repeat(32),VERIFIER_TOKEN:'v'.repeat(32),
    P1_TOKEN:'1'.repeat(32),P2_TOKEN:'2'.repeat(32),P3_TOKEN:'3'.repeat(32),RESOURCE_JOURNAL_PATH:'/srv/thesis-data/resource/events.jsonl',COLLECTOR_JOURNAL_PATH:'/srv/thesis-data/collector/events.jsonl'};
  assert.doesNotThrow(()=>validateResearchServiceConfig('resource',env));
  assert.doesNotThrow(()=>validateResearchServiceConfig('collector',env));
  assert.throws(()=>validateResearchServiceConfig('resource',{...env,P1_TOKEN:undefined}),/credentials/);
  assert.throws(()=>validateResearchServiceConfig('resource',{...env,P2_TOKEN:env.P1_TOKEN}),/credentials/);
  assert.throws(()=>validateResearchServiceConfig('collector',{...env,VERIFIER_TOKEN:env.ADMIN_TOKEN}),/credentials/);
  assert.throws(()=>validateResearchServiceConfig('collector',{...env,COLLECTOR_JOURNAL_PATH:'relative.jsonl'}),/journal/);
  assert.throws(()=>validateResearchServiceConfig('resource',{...env,RESEARCH_SERVICE_MODE:'unknown'}),/mode/);
  assert.throws(()=>validateResearchServiceConfig('resource',{NODE_ENV:'production'}),/explicit research service mode/);
  assert.doesNotThrow(()=>validateResearchServiceConfig('resource',{}));
});
