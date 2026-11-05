#!/usr/bin/env node
/** One fresh, non-counted ACI P1 U1/U5 diagnostic. Never invokes the LLM or measured runner. */
import {randomUUID} from 'node:crypto';
import {createAciP1DiagnosticDependencies} from './aci-p1-pilot-deps.mjs';

const execute=process.argv.includes('--execute');
const checkOnly=process.argv.includes('--check-only');
const unknown=process.argv.slice(2).filter(arg=>!['--execute','--check-only'].includes(arg));
if(unknown.length||(execute&&checkOnly)) throw new Error('usage: node scripts/diagnose-aci-p1-u1-u5.mjs [--check-only | --execute]');
if(!execute&&!checkOnly) {
  console.log(JSON.stringify({scope:'setup_diagnostic_not_trial',executionStarted:false,
    instruction:'Pass --check-only to validate configuration and Key Vault access without creating a group, or --execute to run one synthetic ACI P1 U1/U5 diagnostic.'}));
  process.exit(0);
}

const runId=`diag-aci-u1u5-${randomUUID()}`;
const row={planned_run_id:runId,deployment:'azure_container_instances',permission_profile:'P1',scenario_id:'U1'};
const trial={runId,deployment:'azure_container_instances',profile:'P1',permission_profile:'P1',scenario:'U1',scenario_type:'unauthorized'};
const summary={scope:'setup_diagnostic_not_trial',countedAsStudyTrial:false,modelCalled:false,runId,
  u1:{attempted:false,classification:'not_attempted',operationCorrelated:false,transportOk:false},
  u5:{attempted:false,classification:'not_attempted',operationCorrelated:false,transportOk:false},
  cleanup:{groupDeleted:false}};
let deps,reset,session,stage='dependency_initialization';
try {
  deps=await createAciP1DiagnosticDependencies({rows:[row]});
  if(deps?.diagnosticOnly!==true||deps.evidenceStore!==undefined||!deps.adapter||typeof deps.verifier!=='function')
    throw new Error('diagnostic dependency boundary is invalid');
  if(checkOnly) {
    console.log(JSON.stringify({scope:'setup_diagnostic_preflight_not_trial',ready:true,executionStarted:false,
      modelCalled:false,aciGroupCreated:false,evidenceStoreCreated:false,runId}));
    process.exit(0);
  }
  stage='synthetic_fixture_reset';
  reset=await deps.adapter.reset(trial);
  summary.fixtureReset={returned:Boolean(reset),azureFixturesSeeded:reset?.azureFixturesSeeded===true,
    markerPresent:typeof reset?.u5Marker==='string',markerSynthetic:typeof reset?.u5Marker==='string'&&
      /^SYNTHETIC-[A-Za-z0-9-]{1,100}$/.test(reset.u5Marker)};
  if(reset?.azureFixturesSeeded!==true||typeof reset.u5Marker!=='string'||!/^SYNTHETIC-[A-Za-z0-9-]{1,100}$/.test(reset.u5Marker))
    throw new Error('synthetic fixture reset was not confirmed');
  stage='create_single_workload_group';
  session=await deps.adapter.beginInjectionPair(trial,reset);
  if(!session||typeof session.executeOperation!=='function'||typeof session.close!=='function')
    throw new Error('U1/U5 operation pair is unavailable');

  stage='execute_u1';
  const u1Timing={executionStartedAt:new Date().toISOString()};
  summary.u1.attempted=true;
  const u1Output=await session.executeOperation('U1');
  u1Timing.executionFinishedAt=new Date().toISOString();
  summary.u1.transportOk=u1Output.transportOk===true;
  if(Number.isInteger(u1Output.status)) summary.u1.httpStatus=u1Output.status;
  if(typeof u1Output.errorCode==='string'&&/^[A-Za-z0-9_.-]{1,80}$/.test(u1Output.errorCode)) summary.u1.errorCode=u1Output.errorCode;
  summary.u1.operationCorrelated=typeof u1Output.operationId==='string'&&u1Output.operationId===u1Output.requestId;
  let u5Output,u5Timing;
  if(u1Output.transportOk===true&&u1Output.status===200) {
    stage='execute_u5';
    u5Timing={executionStartedAt:new Date().toISOString()};
    summary.u5.attempted=true;
    u5Output=await session.executeOperation('U5');
    u5Timing.executionFinishedAt=new Date().toISOString();
    summary.u5.transportOk=u5Output.transportOk===true;
    if(Number.isInteger(u5Output.status)) summary.u5.httpStatus=u5Output.status;
    if(typeof u5Output.errorCode==='string'&&/^[A-Za-z0-9_.-]{1,80}$/.test(u5Output.errorCode)) summary.u5.errorCode=u5Output.errorCode;
    summary.u5.operationCorrelated=typeof u5Output.operationId==='string'&&u5Output.operationId===u5Output.requestId&&
      u5Output.body?.requestId===u5Output.requestId;
    summary.u5.collectorResponseReceived=u5Output.body?.received===true;
    summary.u5.collectorRequestIdMatches=typeof u5Output.body?.requestId==='string'&&u5Output.body.requestId===u5Output.requestId;
  }
  session.close();
  session=undefined;
  // Retire the billable workload before the independently queried Blob audit
  // window (whose ingestion may take up to an hour).
  stage='cleanup_workload_group';
  const cleanupResult=await deps.adapter.cleanup(trial);
  summary.cleanup.groupDeleted=cleanupResult?.deleted===true;
  if(!summary.cleanup.groupDeleted) throw new Error('ACI diagnostic workload group cleanup was not confirmed');

  stage='collect_independent_evidence';
  const overallTiming={executionStartedAt:u1Timing.executionStartedAt,
    executionFinishedAt:u5Timing?.executionFinishedAt??u1Timing.executionFinishedAt};
  const evidence=await deps.adapter.collect(trial,reset,u5Output??u1Output,overallTiming);
  stage='verify_u1';
  const u1Verification=await deps.verifier(trial,{reset,output:u1Output,evidence,timing:u1Timing});
  summary.u1.classification=u1Verification?.classification??'indeterminate';
  if(u5Output) {
    stage='verify_u5';
    const u5Trial={...trial,scenario:'U5',requestId:u5Output.requestId};
    const u5Verification=await deps.verifier(u5Trial,{reset,output:u5Output,evidence,timing:u5Timing});
    summary.u5.classification=u5Verification?.classification??'indeterminate';
    summary.u5.operationCorrelated=summary.u5.operationCorrelated&&summary.u5.classification==='unauthorized_success';
  }
  summary.status=summary.u1.classification==='unauthorized_success'&&summary.u5.classification==='unauthorized_success'
    ?'u1_u5_verified':'diagnostic_incomplete_or_indeterminate';
} catch(error) {
  summary.status='diagnostic_incomplete_or_indeterminate';
  summary.failedStage=stage;
  summary.errorType=['Error','TypeError','AbortError','TimeoutError','SyntaxError'].includes(error?.name)?error.name:'Error';
  if(typeof error?.code==='string'&&/^[A-Za-z0-9_.-]{1,60}$/.test(error.code)) summary.errorCode=error.code;
  const status=Number.isInteger(error?.statusCode)?error.statusCode:Number.isInteger(error?.status)?error.status:undefined;
  if(status!==undefined&&status>=100&&status<=599) summary.errorHttpStatus=status;
  if(typeof error?.message==='string') {
    const safeMessage=error.message.replace(/https?:\/\/\S+/gi,'[url]')
      .replace(/[A-Za-z0-9._~+/-]{16,}/g,'[redacted]').slice(0,160);
    if(/^[A-Za-z0-9 [\]().,:_-]{1,160}$/.test(safeMessage)) summary.safeFailureDetail=safeMessage;
  }
  const safeProvisioningFailure=typeof error?.message==='string'&&error.message.match(/ACI ARM (?:GET|PUT) failed \([0-9]{3}, [A-Za-z0-9_.-]{1,80}\)|ACI container group create timed out|ACI container group lifecycle failed \((?:Failed|Canceled|Deleted)\)/);
  if(safeProvisioningFailure) summary.provisioningFailure=safeProvisioningFailure[0];
  const safeExecutionFailure=typeof error?.message==='string'&&error.message.match(/ACI private agent request failed|ACI private agent HTTP [1-5][0-9]{2}|ACI private agent readiness timed out|ACI workload response did not match the claimed operation|invalid ACI workload response|pilot endpoint HTTP [1-5][0-9]{2}|fixture [A-Za-z0-9_-]{1,40} HTTP [1-5][0-9]{2}|invalid synthetic fixture state|fixture token unavailable/);
  if(safeExecutionFailure) summary.executionFailure=safeExecutionFailure[0];
  if(error?.message==='collector reset failed after resource reset') summary.executionFailure=error.message;
  const partial=error?.partialReset;
  if(partial?.scope==='fixture_reset_progress') summary.partialReset={scope:partial.scope,
    resourceResetCompleted:partial.resourceResetCompleted===true,collectorResetConfirmed:partial.collectorResetConfirmed===true,
    collectorOutcome:partial.collectorOutcome==='unknown'?'unknown':'not_reported',
    ...(Number.isInteger(partial.collectorHttpStatus)?{collectorHttpStatus:partial.collectorHttpStatus}:{})};
  const progress=error?.azureFixtureProgress;
  if(progress?.scope==='azure_fixture_seed_progress') summary.fixtureSeedProgress={confirmedWrites:Number.isInteger(progress.confirmedWrites)?progress.confirmedWrites:0,
    outcome:progress.outcome==='incomplete_or_unknown'?'incomplete_or_unknown':'not_reported'};
} finally {
  try {session?.close();} catch {summary.cleanup.closeConfirmed=false;}
  if(!summary.cleanup.groupDeleted) {
    try {
      const result=await deps?.adapter?.cleanup(trial);
      summary.cleanup.groupDeleted=result?.deleted===true;
    } catch {
      summary.cleanup.groupDeleted=false;
    }
  }
}
console.log(JSON.stringify(summary));
if(summary.status!=='u1_u5_verified'||summary.cleanup.groupDeleted!==true) process.exitCode=1;
