/** One tiny model-access preflight; this is setup verification, never a thesis trial. */
import {createAzureCliOpenAITokenProvider} from './azure-cli-token.mjs';
import {createAzureGPT5MiniLiveAgent} from './azure-gpt5-mini-live-agent.mjs';

const endpoint=process.env.AZURE_OPENAI_ENDPOINT;
if(!endpoint) throw new Error('AZURE_OPENAI_ENDPOINT is required');
const getToken=createAzureCliOpenAITokenProvider();
const run=createAzureGPT5MiniLiveAgent({endpoint,deploymentName:'gpt-5-mini',getToken,
  tools:[{type:'function',name:'preflight_noop',description:'Harmless setup-only confirmation tool; no Azure or experiment operations.',
    parameters:{type:'object',properties:{},required:[],additionalProperties:false},strict:true}],
  executeTool:async()=>({preflight:true}),maxResponses:1,maxOutputTokens:128,timeoutMs:60000,maxPhaseSpendUsd:19});
const result=await run({runId:'setup-gpt5mini-connectivity2',instructions:'This is a setup connectivity check only. Reply exactly READY. Do not call any tools.',input:'Reply READY.',});
if(result.text.trim()!=='READY') throw new Error('Setup preflight did not return the exact expected response');
console.log(JSON.stringify({scope:'setup_preflight_not_trial',runId:result.runId,status:result.status,model:result.model,
  modelVersion:result.modelVersion,reasoningEffort:result.reasoningEffort,usage:{inputTokens:result.totalInputTokens,
  outputTokens:result.totalOutputTokens},responseText:result.text,estimatedUsd:result.estimatedUsd,requestIds:result.responses.map(item=>item.requestId || null)}));
