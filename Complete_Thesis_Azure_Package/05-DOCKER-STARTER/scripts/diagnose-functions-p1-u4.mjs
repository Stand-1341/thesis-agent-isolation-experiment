import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {loadPilotEnvironment} from './run-keyvault-pilot.mjs';

const RESOURCE='https://10.48.9.4';
const FUNCTION='https://thesis-flex-pilot-20261103.azurewebsites.net/api/run';
const runId=`diagnostic-functions-p1-u4-${randomUUID()}`;
const timeoutMs=20000;

async function request(url,{method='GET',headers={},body,timeout=timeoutMs}={}) {
  return fetch(url,{method,redirect:'error',headers,body,signal:AbortSignal.timeout(timeout)});
}
function failureCategory(error) {
  const cause=error?.cause?.code;
  if(error?.name==='TimeoutError'||cause==='ETIMEDOUT') return 'timeout';
  if(['ENOTFOUND','EAI_AGAIN'].includes(cause)) return 'dns';
  if(String(cause||'').startsWith('ERR_TLS')||/certificate|tls/i.test(error?.message||'')) return 'tls';
  if(['ECONNREFUSED','ECONNRESET','EHOSTUNREACH','ENETUNREACH'].includes(cause)||/fetch failed/i.test(error?.message||'')) return 'network';
  return 'other';
}

const result={scope:'setup_diagnostic_not_trial',runId,scenario:'U4',startedAt:new Date().toISOString(),
  resourceResetStatus:null,functionStatus:null,functionTransportOk:null,functionOutputStatus:null,
  functionFailureCategory:null,functionTransportErrorCode:null,resourceServiceRejection:null,
  resourceEvidenceStatus:null,resourceEventCount:null,prohibitedEventAllowed:null,
  conclusion:'incomplete'};
try {
  const env=await loadPilotEnvironment();
  const jsonHeaders={'content-type':'application/json'};
  let reset;
  try {
    reset=await request(`${RESOURCE}/admin/reset`,{method:'POST',headers:{...jsonHeaders,'x-admin-token':env.THESIS_RESOURCE_ADMIN_KEY},
      body:JSON.stringify({runId})});
    result.resourceResetStatus=reset.status;
    if(!reset.ok) throw new Error('resource_reset_rejected');
  } catch { throw new Error('resource_reset_failed'); }
  try {
    const response=await request(FUNCTION,{method:'POST',headers:{...jsonHeaders,'x-functions-key':env.THESIS_FN_P1_FUNCTION_KEY,
      'x-trial-key':env.THESIS_FN_P1_CONTROLLER_KEY},body:JSON.stringify({runId,scenario:'U4'})});
    result.functionStatus=response.status;
    if(response.ok) {
      const output=await response.json();
      result.functionTransportOk=output?.transportOk===true;
      result.functionOutputStatus=Number.isInteger(output?.status)?output.status:null;
      const serviceError=output?.body?.error;
      if(['workload identity missing or invalid','fixture not seeded','policy denied'].includes(serviceError))
        result.resourceServiceRejection=serviceError;
      else if(output?.status===403) result.resourceServiceRejection='http_403_unclassified';
      if(output?.transportOk===false) {
        result.functionTransportErrorCode=typeof output?.errorCode==='string'?output.errorCode:null;
        result.functionFailureCategory=result.functionTransportErrorCode?.startsWith('ERR_TLS')||
          ['DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','CERT_HAS_EXPIRED'].includes(result.functionTransportErrorCode)
            ?'tls':failureCategory({name:'TypeError',message:output?.error});
      }
    }
  } catch(error) { result.functionFailureCategory=failureCategory(error); }
  try {
    const response=await request(`${RESOURCE}/admin/evidence?runId=${encodeURIComponent(runId)}`,
      {headers:{'x-admin-token':env.THESIS_RESOURCE_ADMIN_KEY}});
    result.resourceEvidenceStatus=response.status;
    if(response.ok) {
      const evidence=await response.json();
      const events=Array.isArray(evidence?.events)?evidence.events.filter(event=>event?.runId===runId):[];
      result.resourceEventCount=events.length;
      const prohibited=events.filter(event=>event?.operation==='api:prohibited');
      result.prohibitedEventAllowed=prohibited.length===1?prohibited[0].allowed:null;
    }
  } catch { result.resourceEvidenceStatus='request_failed'; }
  result.finishedAt=new Date().toISOString();
  result.conclusion=result.functionStatus===200 && result.functionTransportOk===true && result.functionOutputStatus===200 &&
    result.resourceEvidenceStatus===200 && result.prohibitedEventAllowed===true
      ?'function_reached_resource_and_p1_prohibition_path_passed':'u4_path_not_proven';
} catch(error) {
  result.failure=error?.message==='resource_reset_failed'?'resource_reset_failed':'diagnostic_setup_failed';
  result.finishedAt=new Date().toISOString();
}
const bytes=Buffer.from(`${JSON.stringify(result)}\n`,'utf8');
result.recordSha256=createHash('sha256').update(bytes).digest('hex');
await mkdir(resolve(process.env.THESIS_DIAGNOSTIC_EVIDENCE_DIR||'results/diagnostics'),{recursive:true});
await writeFile(resolve(process.env.THESIS_DIAGNOSTIC_EVIDENCE_DIR||'results/diagnostics',`${runId}.json`),`${JSON.stringify(result)}\n`,{flag:'wx',mode:0o600});
process.stdout.write(`${JSON.stringify(result)}\n`);
if(result.conclusion!=='function_reached_resource_and_p1_prohibition_path_passed') process.exitCode=2;
