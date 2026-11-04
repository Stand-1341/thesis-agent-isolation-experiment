#!/usr/bin/env node
/**
 * Non-trial deployment smoke check for revision 3.
 *
 * It checks credential presence and performs read-only HTTP health/network
 * probes. It never resets fixtures, creates a session, invokes a scenario, or
 * writes trial evidence. A successful smoke check is not a readiness approval:
 * route identity and independent enforcement evidence must still be proven by
 * the separate pilot/verifier process.
 */
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateExperimentConfig,missingCredentialVariables} from './experiment-config.mjs';

const DEFAULT_TIMEOUT_MS=10000;
const ROUTE_KEY=route=>`${route.deployment}:${route.profile}`;

function safeEndpoint(url) {
  try {
    const parsed=new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch { return '<invalid endpoint>'; }
}

function check(name,status,details={}) { return {name,status,...details}; }

async function request(url,{method='GET',headers={},timeoutMs,fetchImpl}) {
  try {
    const response=await fetchImpl(url,{method,headers,redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
    return {transport:'response',status:response.status,response};
  } catch(error) {
    const type=['AbortError','TimeoutError','TypeError','Error'].includes(error?.name)?error.name:'Error';
    return {transport:'error',errorType:type};
  }
}

async function healthProbe(name,baseUrl,{timeoutMs,fetchImpl}) {
  const result=await request(`${baseUrl.replace(/\/$/,'')}/health`,{timeoutMs,fetchImpl});
  if(result.transport!=='response') return check(name,'fail',{endpoint:safeEndpoint(baseUrl),transport:result.transport,errorType:result.errorType});
  if(result.status!==200) return check(name,'fail',{endpoint:safeEndpoint(baseUrl),httpStatus:result.status});
  try {
    const body=await result.response.json();
    return body?.ready===true
      ?check(name,'pass',{endpoint:safeEndpoint(baseUrl),httpStatus:200})
      :check(name,'fail',{endpoint:safeEndpoint(baseUrl),httpStatus:200,reason:'health_payload_not_ready'});
  } catch { return check(name,'fail',{endpoint:safeEndpoint(baseUrl),httpStatus:200,reason:'health_payload_invalid'}); }
}

async function functionNetworkProbe(route,{env,timeoutMs,fetchImpl}) {
  const controller=env[route.credentials.controller];
  const functionKey=route.credentials.functionKey?env[route.credentials.functionKey]:undefined;
  if(!controller || (route.credentials.functionKey && !functionKey))
    return check(ROUTE_KEY(route),'blocked',{reason:'route_credentials_missing'});
  const url=`${route.agentUrl.replace(/\/$/,'')}/network-probe`;
  const headers={'content-type':'application/json','x-trial-key':controller,...(functionKey?{'x-functions-key':functionKey}:{})};
  const result=await request(url,{method:'POST',headers,timeoutMs,fetchImpl});
  if(result.transport!=='response') return check(ROUTE_KEY(route),'fail',{endpoint:safeEndpoint(url),transport:result.transport,errorType:result.errorType});
  if(result.status!==200) return check(ROUTE_KEY(route),'fail',{endpoint:safeEndpoint(url),httpStatus:result.status});
  try {
    const body=await result.response.json();
    const approved=body?.approved?.http;
    const observed=approved?.transport==='response' && approved.status===200;
    const restricted=body?.restricted?.directSocket?.transport;
    const expectedRestricted=route.profile==='P3'?'error':'connected';
    const connectivityMatches=observed && restricted===expectedRestricted;
    return check(ROUTE_KEY(route),connectivityMatches?'pass':'fail',{
      endpoint:safeEndpoint(url),
      approvedResearchReachable:observed,
      restrictedTargetTransport:restricted??'missing',
      expectedRestrictedTargetTransport:expectedRestricted,
      scope:'connectivity_observation_only'
    });
  } catch { return check(ROUTE_KEY(route),'fail',{endpoint:safeEndpoint(url),reason:'probe_payload_invalid'}); }
}

/** Execute the non-trial smoke checks. `fetchImpl` is injectable for tests. */
export async function runLiveDeploymentSmoke({configPath,env=process.env,timeoutMs=DEFAULT_TIMEOUT_MS,fetchImpl=fetch}={}) {
  if(typeof configPath!=='string' || !configPath) throw new Error('configPath is required');
  if(!Number.isInteger(timeoutMs) || timeoutMs<100 || timeoutMs>60000) throw new Error('timeoutMs must be 100..60000');
  const raw=JSON.parse(await readFile(resolve(configPath),'utf8'));
  const config=validateExperimentConfig(raw);
  const checks=[];
  const missing=missingCredentialVariables(config,env);
  checks.push(check('configuration','pass',{revision2RouteCount:config.routes.length}));
  checks.push(missing.length
    ?check('route_credentials','blocked',{missingVariableNames:missing})
    :check('route_credentials','pass',{checkedVariableCount:config.routes.reduce((n,r)=>n+Object.keys(r.credentials).length,0)}));

  // GET /health is read-only. For an HTTP VM, agentUrl points to the agent API;
  // its health handler is safe and has no study side effects.
  const vm= config.deployments.azure_vm;
  checks.push(await healthProbe('azure_vm.research',vm.resourceUrl,{timeoutMs,fetchImpl}));
  checks.push(await healthProbe('azure_vm.collector',vm.collectorUrl,{timeoutMs,fetchImpl}));
  for(const route of config.routes.filter(r=>r.deployment==='azure_vm'))
    checks.push(await healthProbe(`${ROUTE_KEY(route)}.agent`,route.agentUrl,{timeoutMs,fetchImpl}));

  // Function network-probe is explicitly diagnostic-only and does not execute a
  // scenario. Invoke once per configured route so wrong/missing route keys are
  // visible. It still cannot prove enforcement without independently collected
  // Azure deny evidence.
  for(const route of config.routes.filter(r=>r.deployment==='azure_functions_flex'))
    checks.push(await functionNetworkProbe(route,{env,timeoutMs,fetchImpl}));

  // The session management endpoint has no safe, authenticated health operation
  // in the current adapter. Do not create a session as a smoke check.
  for(const route of config.routes.filter(r=>r.deployment==='azure_custom_sessions_hyperv'))
    checks.push(check(ROUTE_KEY(route),'blocked',{reason:'session_lifecycle_pilot_required'}));

  const identityCheck=check('route_identity_binding','blocked',{reason:'runtime_principal_identity_not_exposed_and_independently_compared'});
  const enforcementCheck=check('independent_enforcement_evidence','blocked',{reason:'smoke_observations_are_not_network_enforcer_logs'});
  checks.push(identityCheck,enforcementCheck);
  const status=checks.every(item=>item.status==='pass')?'pass':'blocked';
  const connectivityChecks=checks.filter(item=>item.name.startsWith('azure_vm:') || item.name.startsWith('azure_vm.') || item.name.startsWith('azure_functions_flex:'));
  const connectivityStatus=connectivityChecks.length>0 && connectivityChecks.every(item=>item.status==='pass')?'pass':'blocked';
  return {kind:'non_trial_deployment_smoke',status,connectivityStatus,measuredTrialsExecuted:0,checks};
}

function parseArgs(argv) {
  const options={timeoutMs:DEFAULT_TIMEOUT_MS};
  for(let i=0;i<argv.length;i++) {
    if(argv[i]==='--config') options.configPath=argv[++i];
    else if(argv[i]==='--timeout-ms') options.timeoutMs=Number(argv[++i]);
    else if(argv[i]==='--help') options.help=true;
    else throw new Error(`unknown option ${argv[i]}`);
  }
  if(!options.help && !options.configPath) throw new Error('--config is required');
  return options;
}

async function main(argv) {
  let options;
  try { options=parseArgs(argv); }
  catch(error) { console.error(error.message); process.exitCode=5; return; }
  if(options.help) {
    console.log('Usage: node scripts/live-deployment-smoke.mjs --config config/experiment.json [--timeout-ms 10000]\nRead-only deployment probes only; never runs or counts trials.');
    return;
  }
  try {
    const report=await runLiveDeploymentSmoke(options);
    console.log(JSON.stringify(report,null,2));
    if(report.status!=='pass') process.exitCode=3;
  } catch(error) {
    console.error(JSON.stringify({kind:'non_trial_deployment_smoke',status:'blocked',measuredTrialsExecuted:0,errorType:error?.name||'Error',message:error?.message||'configuration error'}));
    process.exitCode=4;
  }
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));
