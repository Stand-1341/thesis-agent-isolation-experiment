/** Fresh non-counted Functions P1 U7 pilot with an independent collector verifier. */
import {randomUUID} from 'node:crypto';
import {open,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {loadPilotEnvironment} from './run-keyvault-pilot.mjs';
import {loadExperimentConfigShape,resolveCredentials} from './experiment-config.mjs';
import {buildRoutes} from './build-experiment.mjs';
import createLiveDeps from './deps-live.mjs';
import {saveEvidence} from './evidence-store.mjs';

const ROUTE='azure_functions_flex:P1';
const routeKeys=new Set([ROUTE]);
const env=await loadPilotEnvironment();
const shape=await loadExperimentConfigShape(resolve('config/experiment.pilot.functions-p1.example.json'));
const config=resolveCredentials(shape,env,routeKeys);
const deps=createLiveDeps({config,env,mode:'non_counted_pilot',routeKeys});
const routes=buildRoutes(config,deps,{routeKeys});
const adapter=routes[ROUTE]?.adapter;
if(!adapter) throw new Error('Functions P1 adapter is unavailable');
const runId=`diagnostic-functions-p1-U7-${randomUUID()}`;
const trial={runId,deployment:'azure_functions_flex',profile:'P1',permission_profile:'P1',scenario:'U7',scenario_type:'unauthorized'};
const directory=resolve(process.env.THESIS_DIAGNOSTIC_EVIDENCE_DIR||'results/diagnostics');
await mkdir(directory,{recursive:true});
const claim=await open(resolve(directory,`${runId}.claim`),'wx',0o600);
await claim.writeFile(JSON.stringify({runId,scope:'non_counted_setup_diagnostic',claimedAt:new Date().toISOString()}));
await claim.sync(); await claim.close();
const record={scope:'non_counted_setup_diagnostic_not_study_trial',runId,trial,startedAt:new Date().toISOString()};
let reset,output,evidence,timing,verification,stage='fixture_reset';
try {
  reset=await adapter.reset(trial);
  timing={executionStartedAt:new Date().toISOString()};
  stage='function_execute';
  output=await adapter.execute(trial,reset);
  timing.executionFinishedAt=new Date().toISOString();
  stage='evidence_collect';
  evidence=await adapter.collect(trial,reset,output,timing);
  stage='independent_verify';
  verification=await deps.collectorVerifier(trial,{reset,output,evidence,timing});
  record.finishedAt=new Date().toISOString();
  const assessment=verification?.evidence?.assessment;
  const event=assessment?.event;
  record.observation={functionRouteAccepted:!!output,workloadTransportOk:output?.transportOk===true,
    workloadHttpStatus:Number.isInteger(output?.status)?output.status:null,
    workloadTransportErrorCode:typeof output?.errorCode==='string'?output.errorCode:undefined,
    collectorEffectIndependentlyVerified:verification?.classification==='unauthorized_success',
    independentVerifier:{classification:verification?.classification??'indeterminate',scope:verification?.evidence?.scope,
      reason:verification?.evidence?.reason??assessment?.reason,candidate:assessment?.candidate,
      matchingRunEvent:event?.runId===runId,operation:event?.operation,windowMatched:!!event},
    controllerEvidenceEvents:Array.isArray(evidence?.collector?.events)?evidence.collector.events.filter(row=>row?.runId===runId).length:0};
  record.classification=verification?.classification??'indeterminate';
} catch(error) {
  record.finishedAt=new Date().toISOString();
  record.errorType=['Error','TypeError','AbortError','TimeoutError','SyntaxError'].includes(error?.name)?error.name:'Error';
  record.classification='indeterminate';
  record.observation={failureStage:stage,partialReset:reset?{azureFixturesSeeded:reset.azureFixturesSeeded===true}:undefined,
    functionRouteAccepted:!!output,workloadTransportOk:output?.transportOk===true,
    workloadHttpStatus:Number.isInteger(output?.status)?output.status:null,
    workloadTransportErrorCode:typeof output?.errorCode==='string'?output.errorCode:undefined};
}
await saveEvidence(directory,record);
process.stdout.write(`${JSON.stringify({scope:record.scope,runId,classification:record.classification,
  failureStage:record.observation?.failureStage??null,
  functionRouteAccepted:record.observation?.functionRouteAccepted??false,
  workloadTransportOk:record.observation?.workloadTransportOk??false,
  workloadHttpStatus:record.observation?.workloadHttpStatus??null,
  workloadTransportErrorCode:record.observation?.workloadTransportErrorCode??null,
  collectorEffectIndependentlyVerified:record.observation?.collectorEffectIndependentlyVerified??false,
  independentVerifier:record.observation?.independentVerifier??null,
  evidencePath:resolve(directory,`${runId}.json`)})}\n`);
if(record.classification==='indeterminate') process.exitCode=2;
