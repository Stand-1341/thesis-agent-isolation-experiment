import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHostedSessionFixturePreparer} from './hosted-session-fixture-preparer.mjs';
import {sessionSeedRequestId} from './azure-session-seed.mjs';
test('hosted fixture requires matching deployment lifecycle and separate owner audit',async()=>{
  const now=Date.now(),owner='00000000-0000-0000-0000-000000000001',resourceId='/subscriptions/test/account',endpoint='https://fixture123.blob.core.windows.net/';
  let current;
  const observation=({deployment,fixtureRunId},state='present')=>({scope:'candidate_hosted_lifecycle',deployment,runId:fixtureRunId,state,sessionFingerprint:'a'.repeat(64),observedAt:new Date(now).toISOString()});
  const config={deployment:'azure_vm',ownerPrincipalId:owner,blobEndpoint:endpoint,blobResourceId:resourceId,clock:()=>now,waitMs:0,
    observe:async args=>observation(args),retire:async args=>observation(args,'not_found'),
    seed:async input=>{current=input;return {scope:'fixture_session_seed_observation',runId:input.runId,kind:input.kind,requestId:sessionSeedRequestId(input.runId,input.kind),status:201,serviceRequestId:'req-1',sessionFingerprint:'a'.repeat(64)};},
    readAudit:async()=>[{TimeGenerated:new Date(now).toISOString(),_ResourceId:resourceId,RequesterObjectId:owner,AuthenticationType:'OAuth',
      ClientRequestId:sessionSeedRequestId(current.runId,current.kind),OperationName:'PutBlob',Uri:`${endpoint}${current.kind}/${current.runId}.json`,StatusCode:201}]};
  const prepare=createHostedSessionFixturePreparer(config);
  const trial={deployment:'azure_vm',scenario:'U6',runId:'run-1'},result=await prepare(trial,{kind:'session-b',marker:'SYNTHETIC-test'});
  assert.equal(result.lifecycle.state,'present');
  let simulatedNow=now,queries=0;
  const delayed=createHostedSessionFixturePreparer({...config,clock:()=>simulatedNow,waitMs:180000,pollMs:60000,
    wait:async ms=>{simulatedNow+=ms;},readAudit:async args=>++queries<3?[]:config.readAudit(args)});
  const delayedResult=await delayed({...trial,runId:'run-delayed'},{kind:'session-b',marker:'SYNTHETIC-test'});
  assert.equal(delayedResult.lifecycle.state,'present'); assert.equal(queries,3); assert.equal(simulatedNow-now,120000);
  assert.equal((await prepare.cleanup(trial,{sessionPreparation:result})).state,'not_found');
  const stale=createHostedSessionFixturePreparer({...config,retire:async args=>({...observation(args,'not_found'),observedAt:new Date(now-1).toISOString()})});
  await assert.rejects(stale.cleanup(trial,{sessionPreparation:result}),/retirement unproven/);
  assert.equal((await prepare({...trial,scenario:'U8',runId:'run-2'},{kind:'prior-session',marker:'SYNTHETIC-test'})).lifecycle.state,'not_found');
  await assert.rejects(prepare({...trial,deployment:'azure_functions_flex'},{kind:'session-b',marker:'SYNTHETIC-test'}),/invalid hosted fixture request/);
  await assert.rejects(createHostedSessionFixturePreparer({...config,readAudit:async()=>[]})(trial,{kind:'session-b',marker:'SYNTHETIC-test'}),/audit missing/);
  await assert.rejects(createHostedSessionFixturePreparer({...config,seed:async input=>({...await config.seed(input),sessionFingerprint:'b'.repeat(64)})})(trial,{kind:'session-b',marker:'SYNTHETIC-test'}),/invalid fixture seed response/);
  await assert.rejects(createHostedSessionFixturePreparer({...config,retire:async args=>observation(args,'present')})({...trial,scenario:'U8'},{kind:'prior-session',marker:'SYNTHETIC-test'}),/transition unproven/);
});
