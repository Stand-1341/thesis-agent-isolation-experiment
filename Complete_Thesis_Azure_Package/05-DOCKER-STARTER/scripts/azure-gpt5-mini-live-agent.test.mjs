import test from 'node:test';
import assert from 'node:assert/strict';
import {AzureModelError,createAzureGPT5MiniLiveAgent} from './azure-gpt5-mini-live-agent.mjs';

const tool={type:'function',name:'perform_assigned_scenario',description:'Run the assigned synthetic fixture operation.',
  parameters:{type:'object',properties:{},required:[],additionalProperties:false},strict:true};
const response=(id,output,usage,status='completed')=>new Response(JSON.stringify({id,model:'gpt-5-mini',output,usage,status}),
  {status:200,headers:{'x-request-id':`request-${id}`}});

test('pins GPT-5 mini low, executes one assigned tool, and records both responses and usage',async()=>{
  const requests=[],toolCalls=[];
  const replies=[response('resp-1',[{type:'function_call',name:'perform_assigned_scenario',call_id:'call-1',arguments:'{}'}],
    {input_tokens:100,output_tokens:50,output_tokens_details:{reasoning_tokens:20}}),
    response('resp-2',[{type:'message',content:[{type:'output_text',text:'completed'}]}],{input_tokens:140,output_tokens:10})];
  const run=createAzureGPT5MiniLiveAgent({endpoint:'https://example.openai.azure.com/',getToken:async()=>'test-token',tools:[tool],
    fetchImpl:async(url,init)=>{requests.push({url,body:JSON.parse(init.body)});return replies.shift();},
    executeTool:async(name,args)=>{toolCalls.push({name,args});return {status:403,scope:'synthetic-fixture'};}});
  const result=await run({runId:'live-unit-1',instructions:'fixed instruction',input:'assigned task'});
  assert.equal(result.status,'completed');
  assert.equal(result.text,'completed');
  assert.equal(result.model,'gpt-5-mini');
  assert.equal(result.reasoningEffort,'low');
  assert.equal(result.totalInputTokens,240);
  assert.equal(result.totalOutputTokens,60);
  assert.equal(result.responses.length,2);
  assert.equal(result.responses[0].usage.reasoningTokens,20);
  assert.equal(toolCalls.length,1);
  assert.equal(requests[0].body.model,'gpt-5-mini');
  assert.deepEqual(requests[0].body.reasoning,{effort:'low'});
  assert.equal(requests[0].body.parallel_tool_calls,false);
  assert.equal(requests[1].body.previous_response_id,'resp-1');
  assert.equal(requests[1].body.input[0].type,'function_call_output');
});

test('rejects incomplete model responses and preserves partial usage evidence',async()=>{
  const run=createAzureGPT5MiniLiveAgent({endpoint:'https://example.openai.azure.com/',getToken:async()=>'test-token',tools:[tool],
    fetchImpl:async()=>response('resp-incomplete',[],{input_tokens:148,output_tokens:0},'incomplete'),executeTool:async()=>({})});
  await assert.rejects(run({runId:'live-unit-2',instructions:'fixed instruction',input:'assigned task'}),error=>{
    assert.ok(error instanceof AzureModelError);
    assert.equal(error.code,'incomplete_response');
    assert.equal(error.partial.totalInputTokens,148);
    assert.equal(error.partial.responses[0].responseStatus,'incomplete');
    return true;
  });
});

test('stops before another model request when a tool reports sensitive exposure',async()=>{
  let requests=0;
  const run=createAzureGPT5MiniLiveAgent({endpoint:'https://example.openai.azure.com/',getToken:async()=>'test-token',tools:[tool],
    fetchImpl:async()=>{requests++;return response('resp-1',[{type:'function_call',name:'perform_assigned_scenario',call_id:'call-1',arguments:'{}'}],{input_tokens:100,output_tokens:20});},
    executeTool:async()=>({errorType:'ControlTokenExposed',transportOk:false,extra:'must-not-save'})});
  await assert.rejects(run({runId:'live-exposure',instructions:'fixed instruction',input:'assigned task'}),error=>{
    assert.equal(error.code,'sensitive_exposure');
    assert.equal(error.partial.toolResults[0].result.errorType,'ControlTokenExposed');
    assert.ok(!JSON.stringify(error.partial).includes('must-not-save'));
    return true;
  });
  assert.equal(requests,1);
});
