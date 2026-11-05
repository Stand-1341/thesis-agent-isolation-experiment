#!/usr/bin/env node
/** Read-only inspection of synthetic fixture evidence from a non-counted ACI diagnostic. */
import {createAciP1DiagnosticDependencies} from './aci-p1-pilot-deps.mjs';

const at=process.argv.indexOf('--run-id');
const runId=at>=0?process.argv[at+1]:undefined;
if(process.argv.length!==4||at!==2||! /^[A-Za-z0-9_-]{1,150}$/.test(runId||''))
  throw new Error('usage: node scripts/inspect-aci-diagnostic-collect.mjs --run-id <diagnostic-run-id>');
const row={planned_run_id:runId,deployment:'azure_container_instances',permission_profile:'P1',scenario_id:'U1'};
const trial={runId,deployment:'azure_container_instances',profile:'P1',permission_profile:'P1',scenario:'U1',scenario_type:'unauthorized'};
const report={scope:'read_only_diagnostic_evidence_inspection_not_trial',runId,evidenceStoreCreated:false,
  workloadGroupCreated:false,modelCalled:false,status:'indeterminate'};
let stage='dependency_initialization';
try {
  const deps=await createAciP1DiagnosticDependencies({rows:[row]});
  if(deps?.diagnosticOnly!==true||deps.evidenceStore!==undefined) throw new Error('diagnostic dependency boundary is invalid');
  stage='read_admin_and_blob_evidence';
  const evidence=await deps.adapter.collect(trial,{}, {},{});
  const collectorEvents=Array.isArray(evidence?.collector?.events)?evidence.collector.events.filter(event=>event?.runId===runId):[];
  report.resourceEvidenceRead=Array.isArray(evidence?.resource?.events);
  report.collectorEvidenceRead=Array.isArray(evidence?.collector?.events);
  report.collectorRunEvents=collectorEvents.length;
  report.collectEvents=collectorEvents.filter(event=>event?.operation==='collect').length;
  report.collectEventsWithRequestId=collectorEvents.filter(event=>event?.operation==='collect'&&typeof event.requestId==='string').length;
  report.collectEventsWithMarkerFingerprint=collectorEvents.filter(event=>event?.operation==='collect'&&typeof event.markerSha256==='string').length;
  report.status='read_completed';
} catch(error) {
  report.failedStage=stage;
  report.errorType=['Error','TypeError','AbortError','TimeoutError'].includes(error?.name)?error.name:'Error';
  const safeFailure=typeof error?.message==='string'&&error.message.match(/pilot endpoint HTTP [1-5][0-9]{2}|collector evidence HTTP [1-5][0-9]{2}|fixture [A-Za-z0-9_-]{1,40} HTTP [1-5][0-9]{2}|fixture token unavailable|managed storage identity unavailable|managed storage identity returned no token|invalid collector evidence|invalid synthetic fixture state/);
  if(safeFailure) report.failure=safeFailure[0];
}
console.log(JSON.stringify(report));
if(report.status!=='read_completed') process.exitCode=1;
