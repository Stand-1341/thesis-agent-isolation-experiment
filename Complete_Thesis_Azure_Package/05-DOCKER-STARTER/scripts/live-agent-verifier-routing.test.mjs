import test from 'node:test';
import assert from 'node:assert/strict';
import {createExperimentVerifier} from './experiment-verifier.mjs';
import {createGPT5MiniLiveAdapter} from './live-agent-trial.mjs';

const config={deployments:{}};
const modelOutput=(scenario,result,agentOutcome='tool_attempted')=>({runId:'live-aci-p1-u1',scenario,arm:'gpt5mini_live',
  agentOutcome,toolResults:result===undefined?[]:[{name:'perform_assigned_scenario',arguments:{},result}]});

test('live GPT tool outcome is normalized before independent Blob verification',async()=>{
  let observed;
  const verifier=createExperimentVerifier({config,blobVerifier:async(trial,observations)=>{
    observed={trial,observations};return {classification:'unauthorized_success',evidence:{source:'independent-blob-audit'}};
  }});
  const trial={runId:'live-aci-p1-u1',scenario:'U1',deployment:'azure_container_instances',profile:'P1'};
  const output=modelOutput('U1',{runId:trial.runId,scenario:'U1',transportOk:true,status:200,body:{marker:'SYNTHETIC-marker'}});
  const result=await verifier(trial,{output,arm:'gpt5mini_live',timing:{executionStartedAt:'2026-11-04T07:00:00Z',executionFinishedAt:'2026-11-04T07:00:01Z'}});
  assert.equal(result.classification,'unauthorized_success');
  assert.equal(observed.observations.output.status,200);
  assert.equal(observed.observations.output.body.marker,'SYNTHETIC-marker');
  assert.equal(observed.observations.arm,'gpt5mini_live');
  assert.equal(observed.observations.output.toolResults,undefined);
});

test('live model that makes no tool call stays a behavior result and does not invoke Azure verifier',async()=>{
  let called=false;
  const verifier=createExperimentVerifier({config,blobVerifier:async()=>{called=true;return {classification:'indeterminate'};}});
  const trial={runId:'live-aci-p1-u1',scenario:'U1',deployment:'azure_container_instances',profile:'P1'};
  const result=await verifier(trial,{output:modelOutput('U1',undefined,'agent_no_attempt'),arm:'gpt5mini_live'});
  assert.equal(result.classification,'agent_no_attempt');
  assert.equal(called,false);
});

test('live GPT adapter preserves ACI failure-cleanup behavior',()=>{
  const baseAdapter={reset:async()=>({}),execute:async()=>({}),collect:async()=>({}),cleanup:async()=>({deleted:true}),cleanupOnFailure:true};
  const adapter=createGPT5MiniLiveAdapter({baseAdapter,endpoint:'https://example.test/openai/deployments/gpt-5-mini/responses',getToken:async()=> 'token'});
  assert.equal(adapter.cleanupOnFailure,true);
  assert.equal(typeof adapter.cleanup,'function');
});
