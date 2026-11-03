import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {recoverSessionRetirement} from './recover-session-retirement.mjs';

test('recovery requires evidence and returns only a session fingerprint',async()=>{
  const sessionId='c'.repeat(48),fingerprint=createHash('sha256').update(sessionId).digest('hex');
  let reads=0,stopped=false;
  const sessionRegistry={read:async runId=>{reads++;return {runId,sessionId,scope:'restricted_session_mapping'};}};
  const observer={observe:async runId=>({runId,sessionFingerprint:fingerprint,state:stopped?'not_found':'present'}),
    requestStop:async(_runId,options)=>{assert.equal(options.evidenceCollected,true);stopped=true;return {scope:'stop_requested_not_confirmed'};}};
  await assert.rejects(recoverSessionRetirement({sessionRegistry,observer,runId:'run-1'}),/evidence collection/);
  assert.equal(reads,0);
  const result=await recoverSessionRetirement({sessionRegistry,observer,runId:'run-1',evidenceCollected:true,waitMs:1000,pollMs:1});
  assert.equal(result.state,'not_found_after_stop');
  assert.ok(!JSON.stringify(result).includes(sessionId));
  await assert.rejects(recoverSessionRetirement({sessionRegistry:{read:async()=>({runId:'other',sessionId,scope:'restricted_session_mapping'})},observer,runId:'run-1',evidenceCollected:true}),/invalid restricted/);
});
