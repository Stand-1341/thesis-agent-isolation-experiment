/** One-shot Container Apps job for the non-counted session header diagnostic. */
import {createHash} from 'node:crypto';
import {ManagedIdentityCredential} from '@azure/identity';
import {createSessionHeaderDiagnostic} from './session-header-diagnostic.mjs';
import {validateSessionControlToken} from './azure-delegated-token.mjs';
import {validateCustomSessionEndpoint} from './session-endpoint.mjs';

const endpoint=process.env.SESSION_MANAGEMENT_ENDPOINT;
const poolName=process.env.SESSION_POOL_NAME;
const region=process.env.AZURE_REGION;
const diagnosticPrincipalId=process.env.DIAGNOSTIC_PRINCIPAL_ID;
const probeNetwork=process.env.P3_NETWORK_PROBE==='true';
if(!endpoint || !poolName || !region || !diagnosticPrincipalId) throw new Error('missing diagnostic job configuration');
const credential=new ManagedIdentityCredential();
const registry=new Map();
let stage='initialize';
let claimChecks;
const sessionRegistry={async save(record){
  if(registry.has(record.runId)) throw new Error('duplicate diagnostic run mapping');
  registry.set(record.runId,Object.freeze({...record}));
}};
async function retireDiagnosticSessions() {
  const poolEndpoint=validateCustomSessionEndpoint(endpoint,{poolName,region});
  const tokenResult=await credential.getToken('https://dynamicsessions.io/.default');
  if(typeof tokenResult?.token!=='string' || !tokenResult.token) throw new Error('session executor identity unavailable');
  validateSessionControlToken({token:tokenResult.token,expectedPrincipalId:diagnosticPrincipalId});
  const apiVersion='2025-02-02-preview';
  const listUrl=new URL(`${poolEndpoint.origin}/.management/listSessions`);
  listUrl.searchParams.set('skip','0');
  listUrl.searchParams.set('api-version',apiVersion);
  const listed=await fetch(listUrl,{method:'POST',headers:{authorization:`Bearer ${tokenResult.token}`},redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!listed.ok) {await listed.body?.cancel();throw new Error(`session cleanup list HTTP ${listed.status}`);}
  const page=await listed.json();
  if(!Array.isArray(page?.value) || page.value.length>10 || page.nextLink) throw new Error('invalid diagnostic session list');
  let stopped=0;
  for(const item of page.value) {
    const sessionId=item?.identifier;
    if(typeof sessionId!=='string' || !/^[a-f0-9]{48}$/.test(sessionId)) throw new Error('invalid diagnostic session identifier');
    const stopUrl=new URL(`${poolEndpoint.origin}/.management/stopSession`);
    stopUrl.searchParams.set('identifier',sessionId);
    stopUrl.searchParams.set('api-version',apiVersion);
    const response=await fetch(stopUrl,{method:'POST',headers:{authorization:`Bearer ${tokenResult.token}`},redirect:'error',signal:AbortSignal.timeout(30000)});
    if(!response.ok && response.status!==404) {await response.body?.cancel();throw new Error(`session cleanup stop HTTP ${response.status}`);}
    await response.body?.cancel();
    if(response.ok) stopped++;
  }
  return {scope:'diagnostic_session_cleanup_only',listedSessions:page.value.length,stopRequestsSucceeded:stopped};
}
const inspect=createSessionHeaderDiagnostic({managementEndpoint:endpoint,poolName,region,diagnosticPrincipalId,sessionRegistry,probeNetwork,
  onStage:value=>{stage=value;},
  getDiagnosticToken:async()=>{
    const result=await credential.getToken('https://dynamicsessions.io/.default');
    if(typeof result?.token!=='string' || !result.token) throw new Error('session executor identity unavailable');
    try {
      const claims=JSON.parse(Buffer.from(result.token.split('.')[1] || '', 'base64url').toString('utf8'));
      const now=Math.floor(Date.now()/1000);
      claimChecks={audienceMatches:claims.aud==='https://dynamicsessions.io',principalMatches:typeof claims.oid==='string' && claims.oid.toLowerCase()===diagnosticPrincipalId.toLowerCase(),
        expirationWithinAcceptedWindow:Number.isSafeInteger(claims.exp) && claims.exp>=now+30 && claims.exp<=now+90000,
        notBeforeValid:claims.nbf===undefined || (Number.isSafeInteger(claims.nbf) && claims.nbf<=now+60)};
    } catch {claimChecks={tokenClaimsParseable:false};}
    return result.token;
  }});
try {
  if(process.env.P3_CLEANUP_SESSIONS==='true') {
    stage='diagnostic_session_cleanup';
    console.log(JSON.stringify(await retireDiagnosticSessions()));
  } else {
    const runId=probeNetwork?'setup-session-network-probe':'setup-session-header-diagnostic';
    stage=probeNetwork?'session_network_probe':'session_header_inspection';
    const observation=await inspect(runId);
    const mapping=registry.get(runId);
    if(!mapping?.sessionId) throw new Error('diagnostic mapping missing');
    console.log(JSON.stringify({scope:'setup_diagnostic_not_trial',runId,...observation,
      sessionIdSha256:createHash('sha256').update(mapping.sessionId).digest('hex')}));
  }
} catch(error) {
  const safeCode=typeof error?.code==='string' && /^[A-Za-z0-9_-]{1,80}$/.test(error.code) ? error.code : undefined;
  const message=typeof error?.message==='string' && /^(invalid diagnostic configuration|invalid diagnostic run ID|invalid scoped token|scoped token claims do not match expected identity and audience|session diagnostic HTTP [1-5][0-9]{2}|diagnostic returned sensitive values|invalid diagnostic response)$/.test(error.message) ? error.message : undefined;
  console.log(JSON.stringify({scope:'setup_diagnostic_not_trial',status:'failed',stage,errorType:error?.name || 'Error',...(safeCode?{errorCode:safeCode}:{}),...(message?{failure:message}:{}),...(claimChecks?{claimChecks}:{})}));
  process.exitCode=1;
}
