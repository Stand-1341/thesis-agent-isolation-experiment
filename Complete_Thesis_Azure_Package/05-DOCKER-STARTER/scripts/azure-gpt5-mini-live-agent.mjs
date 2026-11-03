/** Azure GPT-5 mini Responses API tool loop for the controller. No other model can be selected. */
const MODEL='gpt-5-mini';
const MODEL_VERSION='2025-08-07';
const INPUT_RATE=0.25;
const OUTPUT_RATE=2;
const safeName=/^[a-z][a-z0-9_]{0,63}$/;

export class AzureModelError extends Error {
  constructor(message,{status,requestId,code}={}) {
    super(message);
    this.name='AzureModelError';
    if(status!==undefined)this.status=status;
    if(requestId)this.requestId=requestId;
    if(code)this.code=code;
  }
}

function endpointUrl(value) {
  let url;
  try {url=new URL(value);} catch {throw new Error('invalid Azure OpenAI endpoint');}
  if(url.protocol!=='https:' || !/^[a-z0-9-]+\.openai\.azure\.com$/i.test(url.hostname) ||
    url.username || url.password || url.port || url.pathname!=='/' || url.search || url.hash) throw new Error('endpoint must be an Azure OpenAI resource HTTPS hostname');
  return `${url.origin}/openai/responses?api-version=2025-04-01-preview`;
}

function checkTools(tools,executeTool) {
  if(!Array.isArray(tools) || tools.length<1 || tools.length>20 || typeof executeTool!=='function') throw new Error('invalid live-agent tools');
  const names=new Set();
  for(const tool of tools) {
    if(tool?.type!=='function' || !safeName.test(tool.name || '') || names.has(tool.name) ||
      typeof tool.description!=='string' || !tool.description || !tool.parameters || typeof tool.parameters!=='object') throw new Error('invalid function tool definition');
    names.add(tool.name);
  }
  return names;
}

function safeUsage(usage) {
  const input=usage?.input_tokens, output=usage?.output_tokens;
  if(!Number.isSafeInteger(input) || input<0 || !Number.isSafeInteger(output) || output<0) throw new Error('Azure response omitted valid token usage');
  return {inputTokens:input,outputTokens:output,reasoningTokens:Number.isSafeInteger(usage?.output_tokens_details?.reasoning_tokens)?usage.output_tokens_details.reasoning_tokens:0};
}

function outputText(items) {
  return (items || []).filter(item=>item?.type==='message').flatMap(item=>item.content || [])
    .filter(part=>part?.type==='output_text' && typeof part.text==='string').map(part=>part.text).join('\n');
}

/**
 * Create a bounded live-agent loop. `executeTool` must route only to the research
 * workload adapter and must validate run/scenario arguments independently.
 * One call is made at a time; retries, parallel calls, and model fallbacks are disabled.
 */
export function createAzureGPT5MiniLiveAgent({endpoint,deploymentName='gpt-5-mini',getToken,tools,executeTool,fetchImpl=fetch,
  maxResponses=2,maxOutputTokens=2048,timeoutMs=60000,maxPhaseSpendUsd=19,requestReserveUsd=0.01}={}) {
  if(deploymentName!==MODEL) throw new Error('deployment must be exactly gpt-5-mini; model fallback is disabled');
  const url=endpointUrl(endpoint);
  const names=checkTools(tools,executeTool);
  if(typeof getToken!=='function' || typeof fetchImpl!=='function' || !Number.isInteger(maxResponses) || maxResponses<1 || maxResponses>2 ||
    !Number.isInteger(maxOutputTokens) || maxOutputTokens<1 || maxOutputTokens>2048 || !Number.isInteger(timeoutMs) || timeoutMs<1000 || timeoutMs>120000 ||
    !Number.isFinite(maxPhaseSpendUsd) || maxPhaseSpendUsd<=0 || maxPhaseSpendUsd>20 || !Number.isFinite(requestReserveUsd) || requestReserveUsd<0.01 || requestReserveUsd>0.05) throw new Error('invalid GPT-5 mini client limits or credentials');

  return async function runLiveAgent({instructions,input,runId}) {
    if(typeof instructions!=='string' || !instructions.trim() || instructions.length>20000 || typeof input!=='string' || !input.trim() || input.length>20000 ||
      !/^[A-Za-z0-9_-]{1,150}$/.test(runId || '')) throw new Error('invalid live-agent input');
    let previousResponseId, nextInput=input, totalInputTokens=0, totalOutputTokens=0, estimatedUsd=0;
    const responses=[],toolResults=[];
    const partial=()=>({runId,model:MODEL,modelVersion:MODEL_VERSION,reasoningEffort:'low',responses,toolResults,totalInputTokens,totalOutputTokens,estimatedUsd});
    const fail=(message,details={})=>{const error=new AzureModelError(message,details); error.partial=partial(); return error;};
    for(let index=0;index<maxResponses;index++) {
      if(estimatedUsd+requestReserveUsd>maxPhaseSpendUsd) throw fail('Model phase usage guard reached; stopping before another request',{code:'spend_guard'});
      let token;
      try {token=await getToken();} catch {throw fail('Azure OpenAI token acquisition failed',{code:'authentication'});}
      if(typeof token!=='string' || !token || /[\r\n]/.test(token)) throw fail('Azure OpenAI token provider returned an invalid token',{code:'authentication'});
      const body={model:MODEL,instructions,input:nextInput,reasoning:{effort:'low'},tools,tool_choice:'auto',parallel_tool_calls:false,max_output_tokens:maxOutputTokens,
        ...(previousResponseId?{previous_response_id:previousResponseId}:{})};
      let response;
      try {
        response=await fetchImpl(url,{method:'POST',redirect:'error',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
          body:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});
      } catch {throw fail('Azure GPT-5 mini request failed; automatic retries are disabled',{code:'transport'});}
      const requestId=response.headers?.get?.('x-request-id') || response.headers?.get?.('apim-request-id') || undefined;
      if(!response.ok) throw fail(`Azure GPT-5 mini returned HTTP ${response.status}; automatic retries are disabled`,{status:response.status,requestId,code:'http'});
      let data;
      try {data=await response.json();} catch {throw fail('Azure GPT-5 mini returned invalid JSON',{requestId,code:'protocol'});}
      if(typeof data?.id!=='string' || !data.id || typeof data?.model!=='string' || ![MODEL,`${MODEL}-${MODEL_VERSION}`].includes(data.model) || !Array.isArray(data.output))
        throw fail('Azure response model or payload did not match the pinned GPT-5 mini deployment',{requestId,code:'model_mismatch'});
      let usage;
      try {usage=safeUsage(data.usage);} catch {throw fail('Azure response omitted valid token usage',{requestId,code:'usage'});}
      totalInputTokens+=usage.inputTokens; totalOutputTokens+=usage.outputTokens;
      estimatedUsd=(totalInputTokens*INPUT_RATE+totalOutputTokens*OUTPUT_RATE)/1_000_000;
      responses.push({responseId:data.id,requestId,model:data.model,modelVersion:MODEL_VERSION,reasoningEffort:'low',responseStatus:data.status,usage,estimatedUsd});
      const calls=data.output.filter(item=>item?.type==='function_call');
      if(data.status!=='completed') throw fail(`Azure response ended with status ${String(data.status || 'missing')}`,{requestId,code:'incomplete_response'});
      if(calls.length===0) {
        const text=outputText(data.output);
        if(!text.trim()) throw fail('Azure completed the response without text or a tool call',{requestId,code:'empty_response'});
        return {runId,status:'completed',model:MODEL,modelVersion:MODEL_VERSION,reasoningEffort:'low',text,
          responses,toolResults,totalInputTokens,totalOutputTokens,estimatedUsd};
      }
      if(estimatedUsd>=maxPhaseSpendUsd) return {...partial(),status:'spend_guard_reached'};
      if(calls.length!==1) throw fail('Azure returned multiple tool calls despite sequential-call mode',{requestId,code:'parallel_tool_call'});
      const call=calls[0];
      if(!names.has(call.name) || typeof call.call_id!=='string' || !call.call_id || typeof call.arguments!=='string') throw fail('Azure returned an unknown or malformed tool call',{requestId,code:'invalid_tool_call'});
      let args;
      try {args=JSON.parse(call.arguments);} catch {throw fail('Azure returned invalid tool arguments',{requestId,code:'invalid_tool_arguments'});}
      if(!args || typeof args!=='object' || Array.isArray(args)) throw fail('Azure tool arguments must be a JSON object',{requestId,code:'invalid_tool_arguments'});
      let result;
      try {result=await executeTool(call.name,args,{runId,model:MODEL,modelVersion:MODEL_VERSION,reasoningEffort:'low'});} catch {
        throw fail('live-agent tool execution failed; partial model evidence must be preserved',{requestId,code:'tool_execution'});
      }
      if(['ControlTokenExposed','SessionIdentifierExposed','RequestKeyExposed','WorkloadCredentialExposed'].includes(result?.errorType)) {
        toolResults.push({name:call.name,arguments:args,result:{runId,transportOk:false,errorType:result.errorType}});
        throw fail('sensitive value exposure requires investigation',{requestId,code:'sensitive_exposure'});
      }
      const serialized=JSON.stringify(result);
      if(typeof serialized!=='string' || Buffer.byteLength(serialized,'utf8')>16000) throw fail('tool output exceeds the fixed live-agent limit',{requestId,code:'tool_output_limit'});
      toolResults.push({name:call.name,arguments:args,result});
      previousResponseId=data.id;
      nextInput=[{type:'function_call_output',call_id:call.call_id,output:serialized}];
      if(index===maxResponses-1) return {runId,status:'turn_limit_reached',model:MODEL,modelVersion:MODEL_VERSION,reasoningEffort:'low',
        responses,toolResults,totalInputTokens,totalOutputTokens,estimatedUsd};
    }
    throw fail('unexpected live-agent loop exit',{code:'internal'});
  };
}

export const azureGPT5MiniModel=Object.freeze({model:MODEL,version:MODEL_VERSION,reasoningEffort:'low',inputRatePerMillion:INPUT_RATE,outputRatePerMillion:OUTPUT_RATE});
