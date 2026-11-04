/** One non-counted GPT-5 mini tool-use pilot against the deployed Functions P1 route. */
import {randomUUID} from 'node:crypto';
import {open,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {ManagedIdentityCredential} from '@azure/identity';
import {loadPilotEnvironment} from './run-keyvault-pilot.mjs';
import {loadExperimentConfigShape,resolveCredentials} from './experiment-config.mjs';
import {buildRoutes} from './build-experiment.mjs';
import createLiveDeps from './deps-live.mjs';
import {createGPT5MiniLiveAdapter,liveAgentPromptManifest} from './live-agent-trial.mjs';
import {saveEvidence} from './evidence-store.mjs';
import {summarizeLiveOutput,toolOutcomeForVerification} from './live-agent-evidence.mjs';

const ROUTE='azure_functions_flex:P1';
const OPENAI_CLIENT_ID=process.env.AZURE_OPENAI_CLIENT_ID||'011128da-854a-43e6-ba75-461be5958b1b';
const OPENAI_SCOPE='https://cognitiveservices.azure.com/.default';
function safeEvidence(evidence,verification,trial) {
  const events=Array.isArray(evidence?.resource?.events)?evidence.resource.events:[];
  const uses=events.filter(event=>event?.runId===trial.runId && event.operation==='credential:use');
  const assessment=verification?.evidence?.assessment;
  const audit=assessment?.audit;
  return {resourceUseEvents:uses.map(event=>({runIdMatches:event.runId===trial.runId,operation:event.operation,
    allowed:event.allowed===true,profile:event.profile,at:event.at})),
    blobVerification:{classification:verification?.classification,dummyUse:verification?.evidence?.dummyUse,
      audit:audit?{operation:audit.operation,statusCode:audit.statusCode,statusText:audit.statusText,
        clientRequestId:audit.clientRequestId,requesterObjectId:audit.requesterObjectId,resourceId:audit.resourceId}:undefined,
      auditRowCount:verification?.evidence?.auditRows?.length??0,
      assessmentCandidate:assessment?.candidate,assessmentReason:assessment?.reason}};
}

async function claimRun(directory,runId) {
  await mkdir(directory,{recursive:true});
  const claim=await open(resolve(directory,`${runId}.claim`),'wx',0o600);
  try {await claim.writeFile(JSON.stringify({runId,claimedAt:new Date().toISOString(),scope:'non_counted_live_agent_pilot'}));await claim.sync();}
  finally {await claim.close();}
}

const endpoint=process.env.AZURE_OPENAI_ENDPOINT;
if(!endpoint) throw new Error('AZURE_OPENAI_ENDPOINT is required');
const env=await loadPilotEnvironment();
const routeKeys=new Set([ROUTE]);
const configShape=await loadExperimentConfigShape(resolve('config/experiment.pilot.functions-p1.example.json'));
const config=resolveCredentials(configShape,env,routeKeys);
const deps=createLiveDeps({config,env,mode:'non_counted_pilot',routeKeys});
const routes=buildRoutes(config,deps,{routeKeys});
const baseAdapter=routes[ROUTE]?.adapter;
if(!baseAdapter) throw new Error('Functions P1 adapter is unavailable');
const credential=new ManagedIdentityCredential({clientId:OPENAI_CLIENT_ID});
const getModelToken=async()=>{
  const token=await credential.getToken(OPENAI_SCOPE);
  if(typeof token?.token!=='string'||!token.token||/[\r\n]/.test(token.token)) throw new Error('model token unavailable');
  return token.token;
};
const runId=`live-pilot-functions-p1-U3-${randomUUID()}`;
const trial={runId,deployment:'azure_functions_flex',profile:'P1',permission_profile:'P1',scenario:'U3',scenario_type:'unauthorized'};
const evidenceDirectory=resolve(process.env.THESIS_LIVE_PILOT_EVIDENCE_DIR||'results/non-counted-pilot');
await claimRun(evidenceDirectory,runId);
const liveAdapter=createGPT5MiniLiveAdapter({baseAdapter,endpoint,getToken:getModelToken,maxPhaseSpendUsd:0.05});
const record={scope:'non_counted_live_agent_pilot_not_study_trial',runId,arm:'gpt5mini_live',mode:'non_counted_pilot',trial,
  startedAt:new Date().toISOString(),promptManifest:liveAgentPromptManifest()};
let reset,output,evidence,verification;
try {
  reset=await liveAdapter.reset(trial);
  const executionStartedAt=new Date().toISOString();
  output=await liveAdapter.execute(trial,reset);
  const executionFinishedAt=new Date().toISOString();
  evidence=await liveAdapter.collect(trial,reset,output,{executionStartedAt,executionFinishedAt});
  verification=await deps.blobVerifier(trial,{reset,output:toolOutcomeForVerification(output),evidence,
    timing:{executionStartedAt,executionFinishedAt}});
  record.finishedAt=new Date().toISOString();
  record.reset={azureFixturesSeeded:reset?.azureFixturesSeeded===true,resourceResetConfirmed:true,collectorResetConfirmed:true};
  record.model=summarizeLiveOutput(output);
  record.evidence=safeEvidence(evidence,verification,trial);
  record.classification=verification.classification;
} catch(error) {
  record.finishedAt=new Date().toISOString();
  record.errorType=['Error','TypeError','AbortError','TimeoutError','SyntaxError'].includes(error?.name)?error.name:'Error';
  record.model=summarizeLiveOutput(error?.partial);
  record.classification='indeterminate';
  if(evidence) record.evidence=safeEvidence(evidence,verification,trial);
}
await saveEvidence(evidenceDirectory,record);
const summary={scope:record.scope,runId,classification:record.classification,
  model:record.model?.model??'gpt-5-mini',modelVersion:record.model?.modelVersion??'2025-08-07',
  modelResponses:record.model?.responses?.length??0,toolCalls:record.model?.toolResults?.length??0,
  agentOutcome:record.model?.agentOutcome??'unknown',inputTokens:record.model?.totalInputTokens??0,
  outputTokens:record.model?.totalOutputTokens??0,estimatedUsd:record.model?.estimatedUsd??0,
  functionStatus:record.model?.toolResults?.[0]?.result?.status??null,
  dummyUseSucceeded:record.model?.toolResults?.[0]?.result?.dummyUse?.succeeded===true,
  matchingCredentialUseEvents:record.evidence?.resourceUseEvents?.filter(event=>event.allowed&&event.runIdMatches).length??0,
  blobAuditOperation:record.evidence?.blobVerification?.audit?.operation??null,
  blobAuditStatus:record.evidence?.blobVerification?.audit?.statusCode??null,
  evidencePath:resolve(evidenceDirectory,`${runId}.json`)};
process.stdout.write(`${JSON.stringify(summary)}\n`);
if(record.classification==='indeterminate'||summary.toolCalls!==1||summary.agentOutcome!=='tool_attempted') process.exitCode=2;
