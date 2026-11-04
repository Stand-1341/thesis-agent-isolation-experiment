import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {loadPilotEnvironment} from './run-keyvault-pilot.mjs';

const RESOURCE='https://10.48.9.4';
const COLLECTOR='https://10.48.9.5:8443';
const FUNCTION='https://thesis-flex-pilot-20261103.azurewebsites.net/api/run';
const runId=`diagnostic-functions-p1-u7-${randomUUID()}`;
const timeoutMs=20000;

async function request(url,{method='GET',headers={},body,timeout=timeoutMs}={}) {
  return fetch(url,{method,redirect:'error',headers,body,signal:AbortSignal.timeout(timeout)});
}

function safeErrorType(error) {
  return ['AbortError','TimeoutError','TypeError'].includes(error?.name)?error.name:'Error';
}

function safeFailureCategory(message) {
  if(typeof message!=='string') return undefined;
  if(/abort|timeout|timed out/i.test(message)) return 'timeout';
  if(/ENOTFOUND|EAI_AGAIN|DNS/i.test(message)) return 'dns';
  if(/TLS|SSL|CERT/i.test(message)) return 'tls';
  if(/ECONN|network|fetch failed/i.test(message)) return 'network';
  return 'other';
}

function summarizeProbe(part) {
  if(!part || typeof part!=='object') return {http:'missing',socket:'missing'};
  return {http:part.http?.transport==='response'?`HTTP ${part.http.status}`:part.http?.errorType||'missing',
    socket:part.directSocket?.transport||'missing',
    ...(part.directSocket?.errorType?{socketError:part.directSocket.errorType}:{})};
}

const result={scope:'setup_diagnostic_not_trial',runId,scenario:'U7',startedAt:new Date().toISOString(),
  resourceResetStatus:null,collectorResetStatus:null,functionStatus:null,functionOutputStatus:null,
  collectorEvidenceStatus:null,matchingCollectorEventCount:null,networkProbeStatus:null,
  conclusion:'incomplete'};

try {
  const env=await loadPilotEnvironment();
  const jsonHeaders={'content-type':'application/json'};
  try {
    const probe=await request('https://thesis-flex-pilot-20261103.azurewebsites.net/api/network-probe',{
      method:'POST',headers:{...jsonHeaders,'x-functions-key':env.THESIS_FN_P1_FUNCTION_KEY,
        'x-trial-key':env.THESIS_FN_P1_CONTROLLER_KEY},body:'{}'});
    result.networkProbeStatus=probe.status;
    if(probe.ok) {
      const body=await probe.json();
      result.researchFromFunction=summarizeProbe(body?.approved);
      result.collectorFromFunction=summarizeProbe(body?.restricted);
    }
  } catch(error) {
    result.networkProbeErrorType=safeErrorType(error);
  }

  const resourceReset=await request(`${RESOURCE}/admin/reset`,{method:'POST',headers:{...jsonHeaders,'x-admin-token':env.THESIS_RESOURCE_ADMIN_KEY},
    body:JSON.stringify({runId})});
  result.resourceResetStatus=resourceReset.status;
  if(!resourceReset.ok) throw new Error('resource_reset_rejected');

  const collectorReset=await request(`${COLLECTOR}/admin/reset`,{method:'POST',headers:{...jsonHeaders,'x-admin-token':env.THESIS_COLLECTOR_ADMIN_KEY},
    body:JSON.stringify({runId})});
  result.collectorResetStatus=collectorReset.status;
  if(!collectorReset.ok) throw new Error('collector_reset_rejected_after_resource_reset');

  try {
    const response=await request(FUNCTION,{method:'POST',timeout:25000,
      headers:{...jsonHeaders,'x-functions-key':env.THESIS_FN_P1_FUNCTION_KEY,'x-trial-key':env.THESIS_FN_P1_CONTROLLER_KEY},
      body:JSON.stringify({runId,scenario:'U7'})});
    result.functionStatus=response.status;
    if(response.ok) {
      const body=await response.json();
      result.functionOutputStatus=Number.isInteger(body?.status)?body.status:null;
      result.functionTransportOk=body?.transportOk===true;
      if(body?.transportOk===false) result.functionFailureCategory=safeFailureCategory(body?.error);
    }
  } catch(error) {
    result.functionErrorType=safeErrorType(error);
  }

  try {
    const response=await request(`${COLLECTOR}/admin/evidence?runId=${encodeURIComponent(runId)}`,
      {headers:{'x-admin-token':env.THESIS_COLLECTOR_ADMIN_KEY}});
    result.collectorEvidenceStatus=response.status;
    if(response.ok) {
      const evidence=await response.json();
      result.matchingCollectorEventCount=Array.isArray(evidence?.events)
        ?evidence.events.filter(event=>event?.runId===runId).length:0;
    }
  } catch(error) {
    result.collectorEvidenceErrorType=safeErrorType(error);
  }

  result.finishedAt=new Date().toISOString();
  result.conclusion=result.functionStatus===200 && result.functionOutputStatus===200 &&
    result.functionTransportOk===true && result.matchingCollectorEventCount===1
      ?'u7_path_reached_collector_once':'u7_path_not_proven';
} catch(error) {
  result.failure=error?.message==='resource_reset_rejected' || error?.message==='collector_reset_rejected_after_resource_reset'
    ?error.message:'diagnostic_setup_failed';
  result.finishedAt=new Date().toISOString();
}

const bytes=Buffer.from(`${JSON.stringify(result)}\n`,'utf8');
result.recordSha256=createHash('sha256').update(bytes).digest('hex');
const evidenceBytes=Buffer.from(`${JSON.stringify(result)}\n`,'utf8');
const directory=resolve(process.env.THESIS_DIAGNOSTIC_EVIDENCE_DIR||'results/diagnostics');
await mkdir(directory,{recursive:true});
await writeFile(resolve(directory,`${runId}.json`),evidenceBytes,{flag:'wx',mode:0o600});
process.stdout.write(`${JSON.stringify(result)}\n`);
if(result.conclusion!=='u7_path_reached_collector_once') process.exitCode=2;
