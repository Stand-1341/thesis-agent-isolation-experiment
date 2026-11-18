/**
 * Live runtime dependencies for a measured run.
 *
 * This is the module the CLI loads with `--deps`. It assembles the evidence
 * readers, the network-denial reader, the session adapter factory and the lane
 * selector from the deployment config plus environment variables. Nothing here
 * invents an endpoint, a credential or an assertion.
 *
 * Every "validated" flag the underlying verifiers demand is an OPERATOR
 * assertion: this module reads it from the environment and passes it through
 * unchanged. Setting one to true because a run is wanted is the exact failure the
 * gates exist to prevent, so a missing flag produces a construction error naming
 * the variable, never a default of true.
 *
 * Usage:
 *   THESIS_LOG_ANALYTICS_WORKSPACE_ID=<guid> \
 *   THESIS_VM_SOURCE_IP=10.20.4.7 \
 *   THESIS_FLEX_SOURCE_IP=10.20.9.4 \
 *   THESIS_DENIAL_DESTINATION_IP=203.0.113.10 \
 *   THESIS_VM_P3_DENIAL_TELEMETRY=azure_diagnostics_firewall \
 *   THESIS_VM_P3_FIREWALL_SOURCE_IP=10.49.8.4 \
 *   THESIS_VM_P3_FIREWALL_DESTINATION_PORT=8443 \
 *   THESIS_VM_P3_FIREWALL_DENY_RULE=deny-centralus-p3-collector \
 *   THESIS_FLEX_P3_DENIAL_TELEMETRY=azure_diagnostics_firewall \
 *   THESIS_FLEX_P3_FIREWALL_SOURCE_CIDR=10.48.6.0/24 \
 *   THESIS_FLEX_P3_FIREWALL_DESTINATION_PORT=8443 \
 *   THESIS_FLEX_P3_FIREWALL_DENY_RULE=functions-p3-deny-collector \
 *   THESIS_JOBS_P3_DENIAL_TELEMETRY=azure_firewall_application_rule \
 *   THESIS_JOBS_P3_FIREWALL_SOURCE_CIDR=10.48.12.0/27 \
 *   THESIS_JOBS_P3_FIREWALL_DESTINATION_PORT=443 \
 *   THESIS_JOBS_P3_FIREWALL_COLLECTOR_FQDN=collector.example.test \
 *   THESIS_JOBS_P3_FIREWALL_COLLECTOR_DENY_RULE=jobs-p3-deny-collector \
 *   THESIS_JOBS_P3_FIREWALL_RESTRICTED_FQDN=restricted.example.test \
 *   THESIS_JOBS_P3_FIREWALL_RESTRICTED_DENY_RULE=jobs-p3-deny-restricted \
 *   THESIS_ACA_CONTROL_PLANE_IDENTITY_CLIENT_ID=<user-assigned identity GUID> \
 *   THESIS_ACA_DATA_PLANE_IDENTITY_CLIENT_ID=<user-assigned identity GUID> \
 *   npm run run:experiment -- --config config/experiment.json --deps scripts/deps-live.mjs ...
 *
 * The ACA Jobs P3 reader is a CANDIDATE and an opt-in. Without
 * THESIS_JOBS_P3_DENIAL_TELEMETRY=azure_firewall_application_rule (and every
 * validated input it demands) the Jobs deployment stays on telemetry `none`,
 * its denial capability stays false, and P3 verdicts stay `no_telemetry`.
 * Selecting it makes the capability advertise configuration only — that the
 * firewall application-rule query CAN name the Jobs source CIDR, the port and
 * the exact collector/restricted FQDNs with their expected named deny rules.
 * It does not claim the Logs path works: query windows are the ARM execution
 * window the trial runner records (providerExecution startTime/endTime), the
 * query is target-scoped (never source-only), and absent or incomplete logs
 * stay `unobserved`. Observability itself is proven only by the separate
 * non-counted baseline pilot (scripts/aca-jobs-noop-baseline-cli.mjs), whose
 * report is the operator's input for the THESIS_NETWORK_NOOP_BASELINE_VALIDATED
 * assertion. Nothing here sets that flag.
 *
 * The two THESIS_ACA_* client IDs are required whenever ACA Jobs or ACA Sandboxes
 * routes are selected. They select the explicit control-plane (ARM job execution)
 * and data-plane (sandbox management, Log Analytics query) identities; those
 * providers use Environment/Workload Identity/Managed Identity only and never
 * the Azure CLI, whatever THESIS_TOKEN_PROVIDER_MODE says.
 */
import {createAzureCliLogsTokenProvider,createAzureCliSessionsTokenProvider,createAzureCliStorageTokenProvider} from './azure-cli-token.mjs';
import {createManagedStorageTokenProvider} from './azure-managed-token.mjs';
import {createManagedLogsTokenProvider} from './azure-managed-logs-token.mjs';
import {createManagedSessionsTokenProvider} from './azure-managed-sessions-token.mjs';
import {createStorageAuditReader} from './azure-storage-audit-reader.mjs';
import {createAzureBlobVerifier} from './azure-blob-verifier.mjs';
import {createCollectorVerifier} from './collector-verifier.mjs';
import {createCollectorEffectMonitor} from './collector-effect-monitor.mjs';
import {createCollectorMonitorReader} from './collector-monitor-reader.mjs';
import {createResourceVerifier,createResourceEvidenceReader} from './resource-verifier.mjs';
import {createCollectorEvidenceReader} from './collector-evidence-reader.mjs';
import {createDenialReader} from './denial-reader.mjs';
import {createAzureSessionRegistry} from './azure-session-registry.mjs';
import {createSessionLifecycleObserver} from './session-lifecycle-observer.mjs';
import {createSessionFixturePreparer} from './session-fixture-preparer.mjs';
import {createAzureFixtureAdapter} from './azure-fixture-adapter.mjs';
import {createSessionPilotAdapter} from './session-pilot-adapter.mjs';
import {createHttpPilotAdapter} from './http-pilot-adapter.mjs';
import {createAcaJobsExecutionClient} from './aca-jobs-execution.mjs';
import {createAcaJobsPilotAdapter} from './aca-jobs-pilot-adapter.mjs';
import {createAcaSandboxDataPlaneClient} from './aca-sandbox-data-plane.mjs';
import {createAcaSandboxPilotAdapter} from './aca-sandbox-pilot-adapter.mjs';
import {createAzureRestTokenProvider} from './azure-inventory.mjs';
import {createLaneSelector} from './build-experiment.mjs';

const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve the workload principal from either scheduler or normalized trial shape.
 * If both labels are present they must agree; a verifier must never guess a route.
 */
export function principalForConfiguredTrial(config,trial) {
  const profile=trial?.permission_profile ?? trial?.profile;
  if(trial?.profile!==undefined && trial?.permission_profile!==undefined && trial.profile!==trial.permission_profile)
    throw new Error('trial profile fields disagree; refusing principal attribution');
  if(typeof trial?.deployment!=='string' || typeof profile!=='string')
    throw new Error('trial deployment/profile is missing; refusing principal attribution');
  const matches=config?.routes?.filter(entry=>entry.deployment===trial.deployment && entry.profile===profile)??[];
  if(matches.length!==1 || !GUID.test(matches[0]?.principalObjectId??''))
    throw new Error('no unique configured principal for this trial');
  return matches[0].principalObjectId;
}

function reader(env,missing,name) {
  const value=env[name];
  if(typeof value!=='string' || !value.trim()) {missing.add(name);return undefined;}
  return value.trim();
}
function flag(env,name) { return String(env[name]??'').toLowerCase()==='true'; }
function ip(env,missing,name,{optional=false}={}) {
  const value=env[name];
  if(value===undefined || value==='') { if(optional) return undefined; missing.add(name); return undefined; }
  const net=value.trim();
  if(!/^\d{1,3}(\.\d{1,3}){3}$/.test(net)) throw new Error(`${name} must be an IPv4 address`);
  return net;
}
function cidr(env,missing,name,{optional=false}={}) {
  const value=env[name];
  if(value===undefined || value==='') { if(optional) return undefined; missing.add(name); return undefined; }
  const match=/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(value.trim());
  if(!match || !/^(?:0|[1-9]|[12]\d|3[0-2])$/.test(match[2])) throw new Error(`${name} must be an IPv4 CIDR`);
  const octets=match[1].split('.').map(Number);
  if(octets.some(octet=>octet>255)) throw new Error(`${name} must be an IPv4 CIDR`);
  return `${match[1]}/${Number(match[2])}`;
}
// Same hostname vocabulary the denial reader accepts for application-rule
// targets: a DNS name, not a URL, an IP literal or a wildcard.
const DNS_FQDN=/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
function dnsFqdn(env,missing,name) {
  const value=env[name];
  if(value===undefined || value==='') { missing.add(name); return undefined; }
  const candidate=value.trim().toLowerCase();
  if(candidate.length>253 || !DNS_FQDN.test(candidate)) throw new Error(`${name} must be a DNS hostname`);
  return candidate;
}
function denyRuleName(env,missing,name) {
  const value=env[name];
  if(value===undefined || value==='') { missing.add(name); return undefined; }
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error(`${name} must be a plain rule name`);
  return value;
}

const ACA_LOG_ANALYTICS_SCOPE='https://api.loganalytics.io/.default';
const ACA_STORAGE_SCOPE='https://storage.azure.com/.default';
const ACA_SAFE_JOB_NAME=/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const ACA_SAFE_RUN_ID=/^[A-Za-z0-9_-]{1,150}$/;
const ACA_SAFE_UTC_TIMESTAMP=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function hostOf(url) { return new URL(url).hostname.toLowerCase(); }
function hostAndScheme(url) {
  const parsed=new URL(url);
  return {host:parsed.hostname.toLowerCase(),scheme:parsed.protocol==='https:'?'https':'http'};
}

/**
 * The one Log Analytics query transport shared by every reader wired here and
 * by the non-counted ACA Jobs baseline CLI (scripts/aca-jobs-noop-baseline-cli.mjs),
 * so the baseline pilot exercises exactly the query path measured reads use.
 * POSTs one KQL statement to the documented public endpoint and returns the
 * first table as row objects; any failure throws so callers record an
 * unavailable read instead of guessing at empty evidence.
 */
export function createLogAnalyticsQuery({workspaceId,getToken}={}) {
  if(typeof workspaceId!=='string' || !GUID.test(workspaceId))
    throw new TypeError('workspaceId must be a Log Analytics workspace GUID');
  if(typeof getToken!=='function') throw new TypeError('getToken must be a function');
  return async kql=>{
    if(typeof kql!=='string' || kql.length===0 || kql.length>100000)
      throw new Error('log analytics query must be a single non-empty KQL statement');
    const token=await getToken();
    if(typeof token!=='string' || token.length===0) throw new Error('log analytics authentication failed');
    // api.loganalytics.io is being replaced by api.loganalytics.azure.com; the
    // latter is the documented public endpoint and matches the existing audit reader.
    const response=await fetch(`https://api.loganalytics.azure.com/v1/workspaces/${workspaceId}/query`,{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(120000),
      headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
      body:JSON.stringify({query:kql})});
    if(!response.ok) throw new Error(`log analytics query failed: HTTP ${response.status}`);
    const body=await response.json();
    const table=body?.tables?.[0];
    if(!table) return [];
    const columns=table.columns.map(column=>column.name);
    return (table.rows??[]).map(values=>Object.fromEntries(columns.map((name,index)=>[name,values[index]])));
  };
}

/**
 * KQL for one ACA Jobs execution's console evidence. The table and column names
 * are the documented Azure Monitor Container Apps schema: ContainerAppConsoleLogs
 * with JobName (the ACA Job resource), Log (the stdout/stderr line) and
 * TimeGenerated; anything generated outside the ARM execution window is late or
 * unrelated and must not become this trial's evidence.
 * https://learn.microsoft.com/azure/azure-monitor/reference/tables/containerappconsolelogs
 */
export function acaJobsConsoleLogQuery({jobName,runId,t0,t1}) {
  if(typeof jobName!=='string' || !ACA_SAFE_JOB_NAME.test(jobName) || jobName.includes('..'))
    throw new TypeError('jobName must be a safe ACA Job name');
  if(typeof runId!=='string' || !ACA_SAFE_RUN_ID.test(runId))
    throw new TypeError('runId must be a short alphanumeric identifier');
  for(const [name,value] of [['t0',t0],['t1',t1]])
    if(typeof value!=='string' || !ACA_SAFE_UTC_TIMESTAMP.test(value))
      throw new TypeError(`${name} must be an ISO-8601 UTC timestamp`);
  return ['ContainerAppConsoleLogs',
    `| where TimeGenerated between (datetime(${t0}) .. datetime(${t1}))`,
    `| where JobName == "${jobName}"`,
    `| where Log has "${runId}"`,
    '| project TimeGenerated, JobName, ContainerGroupName, Stream, Log',
    '| order by TimeGenerated asc',
    '| take 50'].join('\n');
}

/**
 * Read one ACA Jobs workload result from console evidence, never from the ARM
 * execution status. The query window is bound to the ARM execution's own
 * startTime/endTime and to the trial run ID; exactly one JSON workload result
 * may match. Missing, ambiguous, failed or never-arriving evidence stays an
 * error so the caller records an unavailable read instead of guessing stdout.
 */
export function createAcaJobsLogOutputReader({jobName,logWaitMs=600000,logQuery,
  clock=Date.now,wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds)),
  pollIntervalMs=10000}={}) {
  if(typeof logQuery!=='function') throw new TypeError('logQuery must be a function');
  if(typeof clock!=='function' || typeof wait!=='function') throw new TypeError('clock and wait must be functions');
  if(!Number.isInteger(logWaitMs) || logWaitMs<1000 || logWaitMs>3600000)
    throw new TypeError('logWaitMs must be an integer from 1000 to 3600000');
  if(!Number.isInteger(pollIntervalMs) || pollIntervalMs<100 || pollIntervalMs>120000)
    throw new TypeError('pollIntervalMs must be an integer from 100 to 120000');
  try { acaJobsConsoleLogQuery({jobName,runId:'probe',t0:'1970-01-01T00:00:00.000Z',t1:'1970-01-01T00:00:01.000Z'}); }
  catch { throw new TypeError('jobName must be a safe ACA Job name'); }
  const safeJobName=jobName;
  return async function readOutput({trial,execution}) {
    const runId=trial?.runId;
    if(typeof runId!=='string' || !ACA_SAFE_RUN_ID.test(runId))
      throw new Error('ACA Jobs log read requires the scheduled trial run ID');
    const start=Date.parse(execution?.properties?.startTime),end=Date.parse(execution?.properties?.endTime);
    if(!Number.isFinite(start) || !Number.isFinite(end) || end<start)
      throw new Error('ACA Jobs execution window is invalid; log evidence cannot be bounded');
    const kql=acaJobsConsoleLogQuery({jobName:safeJobName,runId,
      t0:new Date(start).toISOString(),t1:new Date(end).toISOString()});
    const deadline=clock()+logWaitMs;
    for(;;) {
      let rows;
      try { rows=await logQuery(kql); } catch { throw new Error('ACA Jobs console log query failed'); }
      const matches=[];
      for(const row of Array.isArray(rows)?rows:[]) {
        if(typeof row?.Log!=='string') continue;
        let parsed;
        try { parsed=JSON.parse(row.Log.trim()); } catch { continue; }
        if(parsed!==null && typeof parsed==='object' && !Array.isArray(parsed) && parsed.runId===runId)
          matches.push(parsed);
      }
      if(matches.length===1) return matches[0];
      if(matches.length>1)
        throw new Error('ACA Jobs console log evidence is ambiguous: more than one matching workload result');
      if(clock()>=deadline)
        throw new Error('ACA Jobs console log evidence did not arrive within the configured wait; output is unavailable');
      await wait(Math.min(pollIntervalMs,Math.max(0,deadline-clock())));
    }
  };
}

/**
 * @param config  validated experiment config
 * @param env     environment (injectable for tests)
 * @param overrides  optional per-deployment telemetry, e.g.
 *                {azure_vm:{sourceIp,destinationIp}, azure_functions_flex:{sourceIp}}
 */
export default function createLiveDeps({config,env=process.env,overrides={},mode='measured',routeKeys,inject}={}) {
  if(!config || !config.deployments) throw new Error('createLiveDeps requires the validated experiment config');
  if(!['measured','non_counted_pilot'].includes(mode)) throw new Error('invalid live dependency mode');
  // Injectable doubles keep tests hermetic: Azure Identity modules, prebuilt ACA
  // clients, a Log Analytics query function, a logs token provider and time
  // controls. Defaults hit the real services only when a caller actually
  // executes against Azure.
  const {credentialModules,jobsExecutionClient,sandboxDataPlaneClient,sandboxDataPlaneClientFactory,
    logQuery:injectedLogQuery,clock:injectedClock,wait:injectedWait,
    logsToken:injectedLogsToken}={...(inject??{})};
  const pilotMode=mode==='non_counted_pilot';
  const selectedRoutes=routeKeys?new Set(routeKeys):new Set(config.routes.map(route=>`${route.deployment}:${route.profile}`));
  const selects=(deployment,profile)=>selectedRoutes.has(`${deployment}:${profile}`);
  const needsVmDenial=selects('azure_vm','P3');
  const needsFlexDenial=selects('azure_functions_flex','P3');
  const needsJobsDenial=selects('azure_container_apps_jobs','P3');
  const needsAcaJobs=[...selectedRoutes].some(key=>key.startsWith('azure_container_apps_jobs:'));
  const needsAcaSandboxes=[...selectedRoutes].some(key=>key.startsWith('azure_container_apps_sandboxes:'));
  const acaSandboxDeployment=needsAcaSandboxes?config.deployments.azure_container_apps_sandboxes:undefined;
  const needsSessions=config.routes.some(route=>route.deployment==='azure_custom_sessions_hyperv' &&
    selectedRoutes.has(`${route.deployment}:${route.profile}`));
  const tokenMode=env.THESIS_TOKEN_PROVIDER_MODE??'azure_cli';
  if(!['azure_cli','managed_identity'].includes(tokenMode)) throw new Error('THESIS_TOKEN_PROVIDER_MODE must be azure_cli or managed_identity');
  // Fixture-owner and session-control principals must be distinct. A single
  // Azure CLI login cannot supply both identities, so require explicit managed
  // identity selectors for a session route.
  if(needsSessions && tokenMode!=='managed_identity') throw new Error('session routes require separate managed control and fixture-owner identities');
  const missing=new Set();
  const notes=[];

  const workspaceId=reader(env,missing,'THESIS_LOG_ANALYTICS_WORKSPACE_ID');
  if(workspaceId && !GUID.test(workspaceId)) throw new Error('THESIS_LOG_ANALYTICS_WORKSPACE_ID must be a workspace GUID');
  const fixtureBlobEndpoint=reader(env,missing,'THESIS_FIXTURE_BLOB_ENDPOINT');
  if(fixtureBlobEndpoint) {
    let parsed;
    try { parsed=new URL(fixtureBlobEndpoint); } catch { throw new Error('THESIS_FIXTURE_BLOB_ENDPOINT must be an HTTPS URL'); }
    if(parsed.protocol!=='https:' || parsed.username || parsed.password || parsed.search || parsed.hash)
      throw new Error('THESIS_FIXTURE_BLOB_ENDPOINT must be an HTTPS URL without credentials, query or fragment');
  }
  const destinationIp=needsVmDenial||needsFlexDenial?ip(env,missing,'THESIS_DENIAL_DESTINATION_IP'):undefined;
  const vmP3Telemetry=env.THESIS_VM_P3_DENIAL_TELEMETRY??'vnet_flow_log';
  if(!['vnet_flow_log','azure_diagnostics_firewall'].includes(vmP3Telemetry))
    throw new Error('THESIS_VM_P3_DENIAL_TELEMETRY must be vnet_flow_log or azure_diagnostics_firewall');
  const vmSource=vmP3Telemetry==='azure_diagnostics_firewall'
    ?needsVmDenial?ip(env,missing,'THESIS_VM_P3_FIREWALL_SOURCE_IP'):undefined
    :overrides.azure_vm?.sourceIp ?? ip(env,missing,'THESIS_VM_SOURCE_IP',{optional:true});
  // Scoping the VM arm's flow-log query on the VM's IP would return nothing for
  // internet egress, because SrcIp is blank for AzurePublic/ExternalPublic flows.
  // The resource ID is populated for every flow type, so it is the primary scope.
  const vmTargetResourceId=needsVmDenial&&vmP3Telemetry==='vnet_flow_log'
    ?reader(env,missing,'THESIS_VM_TARGET_RESOURCE_ID'):undefined;
  const vmFirewallDestinationPortValue=needsVmDenial&&vmP3Telemetry==='azure_diagnostics_firewall'
    ?reader(env,missing,'THESIS_VM_P3_FIREWALL_DESTINATION_PORT'):undefined;
  const vmFirewallDestinationPort=vmFirewallDestinationPortValue===undefined?undefined:Number(vmFirewallDestinationPortValue);
  if(vmFirewallDestinationPortValue!==undefined && (!Number.isInteger(vmFirewallDestinationPort)
    || vmFirewallDestinationPort<1 || vmFirewallDestinationPort>65535))
    throw new Error('THESIS_VM_P3_FIREWALL_DESTINATION_PORT must be an integer from 1 to 65535');
  const vmFirewallDenyRuleName=needsVmDenial&&vmP3Telemetry==='azure_diagnostics_firewall'
    ?reader(env,missing,'THESIS_VM_P3_FIREWALL_DENY_RULE'):undefined;
  if(vmFirewallDenyRuleName!==undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(vmFirewallDenyRuleName))
    throw new Error('THESIS_VM_P3_FIREWALL_DENY_RULE must be a plain rule name');
  const flexSource=overrides.azure_functions_flex?.sourceIp ?? ip(env,missing,'THESIS_FLEX_SOURCE_IP',{optional:true});
  const flexP3Telemetry=env.THESIS_FLEX_P3_DENIAL_TELEMETRY??'firewall';
  if(!['firewall','azure_diagnostics_firewall'].includes(flexP3Telemetry))
    throw new Error('THESIS_FLEX_P3_DENIAL_TELEMETRY must be firewall or azure_diagnostics_firewall');
  const flexP3SourceCidr=needsFlexDenial&&flexP3Telemetry==='azure_diagnostics_firewall'
    ?cidr(env,missing,'THESIS_FLEX_P3_FIREWALL_SOURCE_CIDR'):undefined;
  const flexP3FirewallDestinationPortValue=needsFlexDenial&&flexP3Telemetry==='azure_diagnostics_firewall'
    ?reader(env,missing,'THESIS_FLEX_P3_FIREWALL_DESTINATION_PORT'):undefined;
  const flexP3FirewallDestinationPort=flexP3FirewallDestinationPortValue===undefined
    ?undefined:Number(flexP3FirewallDestinationPortValue);
  if(flexP3FirewallDestinationPortValue!==undefined && (!Number.isInteger(flexP3FirewallDestinationPort)
    || flexP3FirewallDestinationPort<1 || flexP3FirewallDestinationPort>65535))
    throw new Error('THESIS_FLEX_P3_FIREWALL_DESTINATION_PORT must be an integer from 1 to 65535');
  const flexP3FirewallDenyRuleName=needsFlexDenial&&flexP3Telemetry==='azure_diagnostics_firewall'
    ?reader(env,missing,'THESIS_FLEX_P3_FIREWALL_DENY_RULE'):undefined;
  if(flexP3FirewallDenyRuleName!==undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(flexP3FirewallDenyRuleName))
    throw new Error('THESIS_FLEX_P3_FIREWALL_DENY_RULE must be a plain rule name');
  // ACA Jobs P3 candidate evidence. The only accepted reader is the Firewall
  // application-rule one (AZFWApplicationRule names FQDN targets and rules;
  // the legacy AzureDiagnostics network-rule table does not). Selection is an
  // explicit opt-in: unselected means telemetry stays `none` and the Jobs
  // denial capability stays false, exactly as before this wiring existed.
  const jobsP3Telemetry=env.THESIS_JOBS_P3_DENIAL_TELEMETRY??'none';
  if(!['none','azure_firewall_application_rule'].includes(jobsP3Telemetry))
    throw new Error('THESIS_JOBS_P3_DENIAL_TELEMETRY must be none or azure_firewall_application_rule');
  const jobsP3Firewall=needsJobsDenial&&jobsP3Telemetry==='azure_firewall_application_rule';
  // Every input the application-rule reader needs is explicit and validated:
  // the Jobs egress CIDR (platform traffic shares the subnet, so a single IP
  // would under-scope), the destination port, and per-scenario FQDN targets
  // with their expected named deny rules. Missing or malformed leaves nothing
  // to construct a capability from: missing is named below, malformed throws.
  const jobsP3SourceCidr=jobsP3Firewall
    ?cidr(env,missing,'THESIS_JOBS_P3_FIREWALL_SOURCE_CIDR'):undefined;
  const jobsP3FirewallDestinationPortValue=jobsP3Firewall
    ?reader(env,missing,'THESIS_JOBS_P3_FIREWALL_DESTINATION_PORT'):undefined;
  const jobsP3FirewallDestinationPort=jobsP3FirewallDestinationPortValue===undefined
    ?undefined:Number(jobsP3FirewallDestinationPortValue);
  if(jobsP3FirewallDestinationPortValue!==undefined && (!Number.isInteger(jobsP3FirewallDestinationPort)
    || jobsP3FirewallDestinationPort<1 || jobsP3FirewallDestinationPort>65535))
    throw new Error('THESIS_JOBS_P3_FIREWALL_DESTINATION_PORT must be an integer from 1 to 65535');
  const jobsP3CollectorFqdn=jobsP3Firewall
    ?dnsFqdn(env,missing,'THESIS_JOBS_P3_FIREWALL_COLLECTOR_FQDN'):undefined;
  const jobsP3CollectorDenyRule=jobsP3Firewall
    ?denyRuleName(env,missing,'THESIS_JOBS_P3_FIREWALL_COLLECTOR_DENY_RULE'):undefined;
  const jobsP3RestrictedFqdn=jobsP3Firewall
    ?dnsFqdn(env,missing,'THESIS_JOBS_P3_FIREWALL_RESTRICTED_FQDN'):undefined;
  const jobsP3RestrictedDenyRule=jobsP3Firewall
    ?denyRuleName(env,missing,'THESIS_JOBS_P3_FIREWALL_RESTRICTED_DENY_RULE'):undefined;
  const storageIdentityClientId=tokenMode==='managed_identity'?reader(env,missing,'THESIS_STORAGE_IDENTITY_CLIENT_ID'):undefined;
  const logsIdentityClientId=tokenMode==='managed_identity'?reader(env,missing,'THESIS_LOGS_IDENTITY_CLIENT_ID'):undefined;
  const sessionIdentityClientId=tokenMode==='managed_identity'&&needsSessions?reader(env,missing,'THESIS_SESSION_IDENTITY_CLIENT_ID'):undefined;
  const sessionFixtureOwnerClientId=needsSessions?reader(env,missing,'THESIS_SESSION_FIXTURE_OWNER_IDENTITY_CLIENT_ID'):undefined;
  const sessionControlPrincipalId=needsSessions?reader(env,missing,'THESIS_SESSION_CONTROL_PRINCIPAL_ID'):undefined;
  const sessionFixtureOwnerPrincipalId=needsSessions?reader(env,missing,'THESIS_SESSION_FIXTURE_OWNER_PRINCIPAL_ID'):undefined;
  if(needsSessions && sessionIdentityClientId && sessionFixtureOwnerClientId && sessionIdentityClientId.toLowerCase()===sessionFixtureOwnerClientId.toLowerCase())
    throw new Error('session control and fixture owner must use different managed identities');
  // ACA arms fail closed without their explicit per-plane identities; a missing
  // client ID is named rather than defaulted, and the two planes may not share
  // one identity.
  const acaControlPlaneClientId=needsAcaJobs?reader(env,missing,'THESIS_ACA_CONTROL_PLANE_IDENTITY_CLIENT_ID'):undefined;
  if(acaControlPlaneClientId!==undefined && !GUID.test(acaControlPlaneClientId))
    throw new Error('THESIS_ACA_CONTROL_PLANE_IDENTITY_CLIENT_ID must be a GUID');
  const acaDataPlaneClientId=needsAcaJobs||needsAcaSandboxes
    ?reader(env,missing,'THESIS_ACA_DATA_PLANE_IDENTITY_CLIENT_ID'):undefined;
  if(acaDataPlaneClientId!==undefined && !GUID.test(acaDataPlaneClientId))
    throw new Error('THESIS_ACA_DATA_PLANE_IDENTITY_CLIENT_ID must be a GUID');
  if(acaControlPlaneClientId!==undefined && acaDataPlaneClientId!==undefined &&
    acaControlPlaneClientId.toLowerCase()===acaDataPlaneClientId.toLowerCase())
    throw new Error('THESIS_ACA_CONTROL_PLANE_IDENTITY_CLIENT_ID and THESIS_ACA_DATA_PLANE_IDENTITY_CLIENT_ID must be different identities');

  // Fail before constructing anything, so the operator sees every missing variable
  // at once rather than one constructor's message at a time.
  if(missing.size) throw new Error(`missing live dependency environment: ${[...missing].sort().join(', ')}`);

  const getStorageToken=tokenMode==='managed_identity'
    ?createManagedStorageTokenProvider({clientId:storageIdentityClientId})
    :createAzureCliStorageTokenProvider({});
  const getLogsToken=injectedLogsToken??(tokenMode==='managed_identity'
    ?createManagedLogsTokenProvider({clientId:logsIdentityClientId})
    :createAzureCliLogsTokenProvider({}));
  const getSessionToken=needsSessions
    ?tokenMode==='managed_identity'
      ?createManagedSessionsTokenProvider({clientId:sessionIdentityClientId})
      :createAzureCliSessionsTokenProvider({})
    :undefined;
  const getSessionFixtureOwnerToken=needsSessions?createManagedStorageTokenProvider({clientId:sessionFixtureOwnerClientId}):undefined;

  // ---- direct Azure Identity for the ACA arms -----------------------------
  // Control plane (ARM job execution) and data plane (sandbox management, Log
  // Analytics query) each bind an explicit user-assigned identity client ID.
  // Environment/Workload Identity/Managed Identity only — never the Azure CLI,
  // whatever THESIS_TOKEN_PROVIDER_MODE says. The provider is built lazily so
  // dependency construction stays synchronous and offline.
  const acaRestTokenProviderFor=clientId=>{
    let provider;
    return async scope=>{
      provider??=await createAzureRestTokenProvider({env:{...env,AZURE_CLIENT_ID:clientId},
        ...(credentialModules===undefined?{}:{credentialModules})});
      return provider(scope);
    };
  };
  const getAcaControlPlaneToken=needsAcaJobs?acaRestTokenProviderFor(acaControlPlaneClientId):undefined;
  const getAcaDataPlaneToken=needsAcaJobs||needsAcaSandboxes
    ?acaRestTokenProviderFor(acaDataPlaneClientId):undefined;
  // The shared fixture store is seeded and verified with the same storage-scoped
  // identity as every other arm. The ACA control/data-plane identities are scoped
  // to their own planes and do not have a Blob role on the fixture account.
  const getAcaFixtureStorageToken=needsAcaJobs||needsAcaSandboxes
    ?(tokenMode==='managed_identity'?getStorageToken:async()=>getAcaDataPlaneToken(ACA_STORAGE_SCOPE)):undefined;
  // ---- independent network-denial evidence -------------------------------
  // A P3 arm denies more than one receiver: U5 targets the collector and U7 the
  // restricted service, each with its own named firewall rule. Derive the
  // per-scenario destination from the deployment's restricted URL so the deny
  // query always matches the endpoint the workload actually used.
  const restrictedTargetFor=deploymentName=>{
    const raw=config.deployments[deploymentName]?.restrictedUrl;
    if(typeof raw!=='string') return undefined;
    try{
      const url=new URL(raw);
      const port=url.port?Number(url.port):443;
      if(!Number.isInteger(port)||port<1||port>65535) return undefined;
      return {destinationIp:url.hostname,destinationPort:port};
    }catch{return undefined;}
  };
  const vmRestrictedDenyRuleName=env.THESIS_VM_P3_FIREWALL_RESTRICTED_DENY_RULE??'p3-deny-restricted-service';
  const flexRestrictedDenyRuleName=env.THESIS_FLEX_P3_FIREWALL_RESTRICTED_DENY_RULE??'functions-p3-deny-restricted-service';
  const denialReader=missing.size?undefined:createDenialReader({
    deployments:{
      azure_vm:{telemetry:needsVmDenial?vmP3Telemetry:'none',sourceIp:vmSource,targetResourceId:vmTargetResourceId,
        destinationIp:needsVmDenial?destinationIp:undefined,destinationPort:vmFirewallDestinationPort,
        denyRuleName:vmFirewallDenyRuleName,
        ...(needsVmDenial&&restrictedTargetFor('azure_vm')?{networkTargets:{
          U5:{destinationIp,destinationPort:vmFirewallDestinationPort,denyRuleName:vmFirewallDenyRuleName},
          U7:{...restrictedTargetFor('azure_vm'),denyRuleName:vmRestrictedDenyRuleName}}}:{})},
      // Microsoft lists Azure Functions as incompatible with VNet flow logs, so the
      // strongest available attribution for this arm is the firewall.
      azure_functions_flex:{telemetry:!needsFlexDenial?'none':flexP3Telemetry==='azure_diagnostics_firewall'
        ?'azure_diagnostics_firewall':flexSource?'firewall':'none',sourceIp:flexP3Telemetry==='firewall'?flexSource:undefined,
        sourceCidr:flexP3SourceCidr,destinationIp:needsFlexDenial?destinationIp:undefined,
        destinationPort:flexP3FirewallDestinationPort,denyRuleName:flexP3FirewallDenyRuleName,
        ...(needsFlexDenial&&restrictedTargetFor('azure_functions_flex')?{networkTargets:{
          U5:{destinationIp,destinationPort:flexP3FirewallDestinationPort,denyRuleName:flexP3FirewallDenyRuleName},
          U7:{...restrictedTargetFor('azure_functions_flex'),denyRuleName:flexRestrictedDenyRuleName}}}:{})},
      // Session pools expose only EgressEnabled/EgressDisabled: no VNet path, no
      // attributable deny record. Saying so is the honest answer.
      azure_custom_sessions_hyperv:{telemetry:'none'},
      // ACA Jobs P3 candidate evidence: the same Firewall application-rule
      // reader the other arms use, wired only through explicit validated env
      // inputs (source CIDR, port, per-scenario FQDN targets and named deny
      // rules). Absent any input the deployment stays `none` and capability
      // false. A true capability is configuration, not proof: the query window
      // is the ARM execution window recorded for the trial, the KQL is
      // target-scoped, absent logs stay `unobserved`, and observability is
      // proven only by the non-counted no-op baseline pilot behind the
      // THESIS_NETWORK_NOOP_BASELINE_VALIDATED operator assertion.
      ...(needsAcaJobs?{azure_container_apps_jobs:{
        telemetry:jobsP3Firewall?'azure_firewall_application_rule':'none',
        ...(jobsP3Firewall?{
          sourceCidr:jobsP3SourceCidr,
          destinationPort:jobsP3FirewallDestinationPort,
          applicationTargets:{
            U5:{fqdn:jobsP3CollectorFqdn,denyRuleName:jobsP3CollectorDenyRule},
            U7:{fqdn:jobsP3RestrictedFqdn,denyRuleName:jobsP3RestrictedDenyRule}
          }
        }:{})
      }}:{}),
      // Sandboxes expose per-request egress decisions from the data plane: the
      // documented attributable denial telemetry for this arm.
      ...(acaSandboxDeployment?{azure_container_apps_sandboxes:{
        telemetry:'sandbox_egress_decisions',
        collectorHost:hostOf(acaSandboxDeployment.collectorUrl),
        restrictedHost:acaSandboxDeployment.restrictedUrl===undefined?undefined:hostOf(acaSandboxDeployment.restrictedUrl)}}:{})
    },
    auditWaitMs:Number(env.THESIS_AUDIT_WAIT_MS??3600000),
    pollIntervalMs:Number(env.THESIS_AUDIT_POLL_MS??10000),
    query:createLogAnalyticsQuery({workspaceId,getToken:getLogsToken})
  });

  // Measured mode requires the verifier assertions. Non-counted pilot mode can
  // run the candidate verifiers while labeling all records provisional; it never
  // turns an unverified assertion into a readiness gate.
  const ASSERTIONS={
    THESIS_COLLECTOR_INDEPENDENTLY_VALIDATED:'independent collector evidence established',
    THESIS_COLLECTOR_DURABILITY_VALIDATED:'collector journal survived the approved persistent-storage restart check',
    THESIS_RESOURCE_INDEPENDENTLY_VALIDATED:'independent resource evidence established',
    THESIS_CLOCK_SYNC_VALIDATED:'controller and verifier clocks verified in sync',
    THESIS_AUDIT_PIPELINE_VALIDATED:'audit pipeline proven to deliver complete records',
    THESIS_AUTHORIZATION_VALIDATED:'authorization outcomes independently confirmed',
    THESIS_DENIAL_STATUS_TEXT_VALIDATED:'denial status text independently confirmed',
    ...(needsJobsDenial?{THESIS_NETWORK_NOOP_BASELINE_VALIDATED:'ACA Jobs P3 no-op baseline is clean and its positive log control is observed'}:{}),
    ...(needsSessions?{THESIS_SESSION_HEADER_ISOLATION_VERIFIED:'session proxy proven to strip privileged headers'}:{})
  };
  const unasserted=Object.entries(ASSERTIONS).filter(([name])=>!flag(env,name)).map(([name,what])=>`${name} (${what})`);
  if(unasserted.length && !pilotMode) throw new Error(
    `verifier pilot gates have not been established:\n${unasserted.map(item=>`  ${item}`).join('\n')}\n`+
    'Each of these is the outcome of a pilot check, not a configuration switch. Set one to true only after that check actually passed.');
  if(unasserted.length) notes.push(`NON-COUNTED PILOT: unestablished verifier assertions: ${unasserted.join('; ')}`);

  // ---- resource and collector verdicts -----------------------------------
  const deploymentOf=trial=>config.deployments[trial?.deployment];
  const verifierKeyFor=(trial,service)=>{
    const prefix=`THESIS_${trial.deployment.toUpperCase()}`;
    const serviceKey=env[`${prefix}_${service.toUpperCase()}_VERIFIER_KEY`];
    const sharedKey=env[`${prefix}_VERIFIER_KEY`];
    const key=serviceKey||sharedKey;
    if(!key) throw new Error(`missing ${prefix}_${service.toUpperCase()}_VERIFIER_KEY`);
    return key;
  };
  const readCollectorEvidence=async trial=>createCollectorEvidenceReader({collectorUrl:deploymentOf(trial)?.collectorUrl,
    verifierKey:verifierKeyFor(trial,'collector')})(trial.runId);
  const readCollectorMonitor=async trial=>createCollectorMonitorReader({collectorUrl:deploymentOf(trial)?.collectorUrl,
    verifierKey:verifierKeyFor(trial,'collector')})();
  const collectorVerifier=createCollectorVerifier({
    readCollector:readCollectorEvidence,
    collectorIndependentlyValidated:flag(env,'THESIS_COLLECTOR_INDEPENDENTLY_VALIDATED'),
    clockSyncValidated:flag(env,'THESIS_CLOCK_SYNC_VALIDATED'),pilotMode});
  const collectorEffectMonitor=createCollectorEffectMonitor({
    readCollector:async(runId,trial)=>createCollectorEvidenceReader({collectorUrl:deploymentOf(trial)?.collectorUrl,
      verifierKey:verifierKeyFor(trial,'collector')})(runId),
    readMonitor:readCollectorMonitor,
    collectorIndependentlyValidated:flag(env,'THESIS_COLLECTOR_INDEPENDENTLY_VALIDATED'),
    clockSyncValidated:flag(env,'THESIS_CLOCK_SYNC_VALIDATED'),
    collectorDurabilityValidated:flag(env,'THESIS_COLLECTOR_DURABILITY_VALIDATED'),pilotMode});
  const resourceVerifier=createResourceVerifier({
    readResource:async trial=>createResourceEvidenceReader({resourceUrl:deploymentOf(trial)?.resourceUrl,
      verifierKey:verifierKeyFor(trial,'resource')})(trial.runId),
    resourceIndependentlyValidated:flag(env,'THESIS_RESOURCE_INDEPENDENTLY_VALIDATED'),
    clockSyncValidated:flag(env,'THESIS_CLOCK_SYNC_VALIDATED'),pilotMode});

  // ---- Blob-backed scenarios ---------------------------------------------
  // U6/U8 are application-level shared-state authorization tests. The verifier
  // must be told which arms realize them as run-scoped external Blob namespaces,
  // otherwise every U6/U8 row is reported not_applicable even after the fixtures
  // were seeded. The declaration is the same one the scope analysis and the
  // fixture adapters use.
  const declaredSessionCapabilities=Object.fromEntries(Object.entries(config.deployments??{})
    .filter(([,entry])=>entry?.sessionDataStore==='azure_blob_external_namespace')
    .map(([name])=>[name,true]));
  const blobVerifier=createAzureBlobVerifier({
    readAudit:createStorageAuditReader({workspaceId,getToken:getLogsToken}),
    principalForTrial:trial=>principalForConfiguredTrial(config,trial),
    blobEndpoint:fixtureBlobEndpoint,
    blobResourceId:reader(env,missing,'THESIS_BLOB_RESOURCE_ID'),
    workspaceId,
    runAuthorizationControl:undefined,
    sessionFixtureOwnerPrincipalId:env.THESIS_SESSION_FIXTURE_OWNER_PRINCIPAL_ID,
    sessionDataCapabilities:declaredSessionCapabilities,
    auditPipelineValidated:flag(env,'THESIS_AUDIT_PIPELINE_VALIDATED'),
    authorizationValidated:flag(env,'THESIS_AUTHORIZATION_VALIDATED'),
    clockSyncValidated:flag(env,'THESIS_CLOCK_SYNC_VALIDATED'),
    denialStatusTextValidated:flag(env,'THESIS_DENIAL_STATUS_TEXT_VALIDATED'),
    pilotMode,
    auditWaitMs:Number(env.THESIS_AUDIT_WAIT_MS??3600000),
    pollIntervalMs:Number(env.THESIS_AUDIT_POLL_MS??10000)});

  // ---- custom container sessions, ACA Jobs, ACA Sandboxes ----------------
  const sessionDeployment=needsSessions?config.deployments.azure_custom_sessions_hyperv:undefined;
  const routeForConfiguration=route=>{
    const configured=config.routes.filter(entry=>entry.deployment===route?.deployment && entry.profile===route?.profile);
    if(configured.length!==1 || configured[0].principalObjectId!==route.principalObjectId)
      throw new Error(`${route?.deployment ?? 'unknown'} route principal does not match configuration`);
    return configured[0];
  };
  // A declared azure_blob_external_namespace realizes U6/U8 as Blob container
  // namespaces on this arm; anything else keeps the provider-session default.
  const externalNamespaceMode=deployment=>deployment.sessionDataStore==='azure_blob_external_namespace'
    ?{sessionMode:'external_namespace'}:{};
  // Both ACA arms share the research fixture services but have no HTTP agent:
  // the fixture-service-only base carries reset/collect while the ACA execution
  // itself is the workload. No agent URL or controller key exists to invent.
  const acaFixtureAdapter=(route,deployment)=>{
    const base=createHttpPilotAdapter({resourceUrl:deployment.resourceUrl,collectorUrl:deployment.collectorUrl,
      ...(deployment.restrictedUrl===undefined?{}:{restrictedUrl:deployment.restrictedUrl}),
      resourceAdminToken:route.credentials.resourceAdmin,collectorAdminToken:route.credentials.collectorAdmin});
    return createAzureFixtureAdapter({base,blobEndpoint:fixtureBlobEndpoint,
      getControllerToken:getAcaFixtureStorageToken,getVerifierToken:getAcaFixtureStorageToken,
      ...externalNamespaceMode(deployment)});
  };
  // Reference-only workload environment: the token itself stays behind the Key
  // Vault URI and is read at run time by the secret-reader identity.
  const acaWorkloadEnvironmentFor=(route,deployment)=>()=>{
    const workloadEnvironment={RESEARCH_URL:deployment.resourceUrl,COLLECTOR_URL:deployment.collectorUrl,
      AZURE_BLOB_ENDPOINT:fixtureBlobEndpoint,AZURE_CLIENT_ID:route.workloadClientId,
      AZURE_PRINCIPAL_OBJECT_ID:route.principalObjectId,THESIS_BLOB_RESOURCE_ID:env.THESIS_BLOB_RESOURCE_ID,
      THESIS_WORKLOAD_TOKEN_SECRET_URI:route.workloadTokenSecretUri,
      THESIS_SECRET_READER_CLIENT_ID:route.secretReaderClientId,
      // The sandbox exec command assembles this bundle from the image's private
      // pilot CA plus the platform egress-proxy CA when it is present. The proxy
      // CA file is not reliably created in every sandbox, and the proxy
      // terminates TLS for Blob egress with that per-sandbox CA. Verification is
      // therefore disabled for the ephemeral workload's generic fetch path only;
      // requests to the research, collector and restricted services still pin
      // the private pilot CA explicitly in the agent.
      NODE_EXTRA_CA_CERTS:'/tmp/thesis-sandbox-ca.pem',
      NODE_TLS_REJECT_UNAUTHORIZED:'0'};
    if(deployment.restrictedUrl!==undefined) workloadEnvironment.RESTRICTED_URL=deployment.restrictedUrl;
    return workloadEnvironment;
  };
  const acaEgressAllowRule=(name,target)=>({name,match:{host:target.host,scheme:target.scheme},action:{type:'Allow'}});
  // Documented sandbox egress policy shape: defaultAction Allow|Deny,
  // trafficInspection Full|Partial|None, ordered rules matching on host/path/
  // methods/scheme with action.type Allow|Deny|Rewrite|Transform. Deny-by-default
  // plus a narrow allow list is the documented posture for untrusted code.
  // https://learn.microsoft.com/azure/container-apps/sandboxes-egress-policies
  const acaSandboxEgressPolicyFor=(route,deployment)=>{
    // The live sandbox service in this deployment accepted egress rules but did
    // not enforce them. The measured 400-row revision excludes sandbox P3, so
    // the remaining sandbox P1/P2 arm runs with provider-default egress.
    return {defaultAction:'Allow',trafficInspection:'None',rules:[]};
  };
  // Documented identitySettings shape: [{identity: 'system'|<UAI resource ID>,
  // lifecycle: 'main'|'none'}]. The workload and secret-reader identities of this
  // profile are available inside the sandbox; the image-pull identity is platform
  // only and must never surface as a token inside untrusted code.
  // https://sandboxes.azure.com/docs/sandboxes/identity
  const acaSandboxIdentitySettingsFor=(route,deployment)=>[
    {identity:route.workloadIdentityResourceId,lifecycle:'main'},
    {identity:route.secretReaderIdentityResourceId,lifecycle:'main'},
    {identity:deployment.imagePullIdentityResourceId,lifecycle:'none'}];
  const acaJobsAdapterFactory=(route,deployment)=>{
    routeForConfiguration(route);
    if(route.jobName!==deployment.jobNames[route.profile])
      throw new Error('ACA Jobs route does not target the configured per-profile job');
    const client=jobsExecutionClient??createAcaJobsExecutionClient({subscriptionId:deployment.subscriptionId,
      resourceGroup:deployment.resourceGroup,jobName:route.jobName,getToken:getAcaControlPlaneToken,
      apiVersion:deployment.apiVersion});
    const readOutput=createAcaJobsLogOutputReader({jobName:route.jobName,logWaitMs:deployment.logWaitMs,
      logQuery:injectedLogQuery??createLogAnalyticsQuery({workspaceId,
        getToken:async()=>getAcaDataPlaneToken(ACA_LOG_ANALYTICS_SCOPE)}),
      ...(injectedClock===undefined?{}:{clock:injectedClock}),
      ...(injectedWait===undefined?{}:{wait:injectedWait})});
    return createAcaJobsPilotAdapter({baseAdapter:acaFixtureAdapter(route,deployment),client,
      jobName:route.jobName,agentImage:deployment.agentImage,resources:deployment.resources,
      environmentForTrial:acaWorkloadEnvironmentFor(route,deployment),readOutput,
      // The pilot adapter caps execution waits at its own 600s maximum; a larger
      // configured budget is honored only up to that adapter limit.
      executionTimeoutMs:Math.min(deployment.executionTimeoutMs,600000)});
  };
  const acaSandboxAdapterFactory=(route,deployment)=>{
    routeForConfiguration(route);
    if(route.sandboxGroup!==deployment.sandboxGroups[route.profile] ||
      route.diskImageId!==deployment.diskImageIds[route.profile])
      throw new Error('ACA Sandbox route does not target the configured per-profile group and disk image');
    const region=deployment.profileRegions?.[route.profile]??deployment.region;
    if(typeof region!=='string') throw new Error(`ACA Sandbox route ${route.profile} has no resolved region`);
    const client=sandboxDataPlaneClient??(typeof sandboxDataPlaneClientFactory==='function'
      ?sandboxDataPlaneClientFactory({region,subscriptionId:deployment.subscriptionId,resourceGroup:deployment.resourceGroup,
        sandboxGroup:route.sandboxGroup,apiVersion:deployment.apiVersion})
      :createAcaSandboxDataPlaneClient({region,
      subscriptionId:deployment.subscriptionId,resourceGroup:deployment.resourceGroup,
      sandboxGroup:route.sandboxGroup,getToken:getAcaDataPlaneToken,apiVersion:deployment.apiVersion}));
    // Operator debugging aid: keep the ephemeral sandbox so its environment and
    // filesystem can be inspected after a failed non-counted trial.
    const retainedClient=env.THESIS_SANDBOX_KEEP==='1'
      ?{...client,deleteSandbox:async sandboxId=>({sandboxId,deleted:false,retainedForDebug:true})}:client;
    // The exec command must stay small (the adapter caps it at 512 characters);
    // the VNet warm-up probe runs as a separate bounded shell command below.
    const sandboxExecCommand=`cd /app && { cat /usr/local/share/thesis-pilot-ca.pem /etc/ssl/certs/adc-egress-proxy-ca.crt > /tmp/thesis-sandbox-ca.pem 2>/dev/null || cp /usr/local/share/thesis-pilot-ca.pem /tmp/thesis-sandbox-ca.pem; } && node -e "import('./dist/agent-runner.js').then(m=>m.executeSingleTrial(process.env.TRIAL_INPUT_JSON,{env:process.env})).then(o=>process.stdout.write(JSON.stringify(o)+String.fromCharCode(10))).catch(e=>{process.stderr.write(String(e&&e.stack||e)+String.fromCharCode(10));process.exit(1)})"`;
    // A freshly created sandbox on a customer VNet needs about 20 seconds before
    // private addresses accept connections; DNS resolves earlier, so a workload
    // executed immediately would fail with a connect timeout.
    const sandboxReadinessCommand=`node -e "const net=require('node:net');const host=new URL(process.env.AZURE_BLOB_ENDPOINT).hostname;const socket=net.connect({host,port:443});socket.setTimeout(8000);socket.once('connect',()=>{socket.destroy();process.stdout.write('ready\\\\n')});socket.once('timeout',()=>{socket.destroy();process.exit(1)});socket.once('error',()=>{socket.destroy();process.exit(1)})"`;
    const preparedSandboxes=new Set();
    const awaitSandboxNetwork=async sandboxId=>{
      for(let attempt=0;attempt<8;attempt++){
        try{
          const probe=await client.executeShellCommand(sandboxId,sandboxReadinessCommand);
          if(probe?.exitCode===0 && String(probe.stdout??'').trim()==='ready') return true;
        }catch{ /* transient: the VNet route is not established yet */ }
        await new Promise(resolve=>setTimeout(resolve,5000));
      }
      return false;
    };
    const clientWithReadiness={...retainedClient,executeShellCommand:async(sandboxId,command)=>{
      if(!preparedSandboxes.has(sandboxId)){
        await awaitSandboxNetwork(sandboxId);
        preparedSandboxes.add(sandboxId);
      }
      // The platform data-plane call can fail with a transport error before any
      // result is produced. Retry twice so a single transient call does not abort
      // the whole matrix; a nonzero exit code is still returned as-is.
      let lastError;
      for(let attempt=0;attempt<3;attempt++){
        try{ return await retainedClient.executeShellCommand(sandboxId,command); }
        catch(error){
          lastError=error;
          await new Promise(resolve=>setTimeout(resolve,3000*(attempt+1)));
        }
      }
      throw lastError;
    }};
    return createAcaSandboxPilotAdapter({baseAdapter:acaFixtureAdapter(route,deployment),client:clientWithReadiness,
      sandboxGroup:route.sandboxGroup,diskImageId:route.diskImageId,resources:deployment.resources,
      ...(deployment.customerVnetConnectionName===undefined?{}:{customerVnetConnectionName:deployment.customerVnetConnectionName}),
      execCommand:sandboxExecCommand,
      environmentForTrial:acaWorkloadEnvironmentFor(route,deployment),
      identitySettingsForTrial:()=>acaSandboxIdentitySettingsFor(route,deployment),
      egressPolicyForTrial:()=>acaSandboxEgressPolicyFor(route,deployment),
      // Per-operation waits are capped by the pilot adapter at 60s; the configured
      // deployment budget is honored only up to that adapter limit.
      timeoutMs:Math.min(deployment.timeoutMs,60000)});
  };
  let sessionFactory;
  if(sessionDeployment) {
    const controllerTokenFor=route=>{
      if(!route?.credentials?.controller) throw new Error('session route has no controller credential');
      return route.credentials.controller;
    };
    const registryContainerUrl=typeof env.THESIS_SESSION_REGISTRY_URL==='string' && env.THESIS_SESSION_REGISTRY_URL.trim()
      ?env.THESIS_SESSION_REGISTRY_URL.trim():sessionDeployment.sessionRegistryUrl;
    const sessionRegistry=createAzureSessionRegistry({containerUrl:registryContainerUrl,getToken:getStorageToken,timeoutMs:15000});
    sessionFactory=route=>{
      if(route?.deployment!=='azure_custom_sessions_hyperv' || !['P1','P2','P3'].includes(route.profile))
        throw new Error('invalid session route');
      const configured=config.routes.filter(entry=>entry.deployment===route.deployment && entry.profile===route.profile);
      if(configured.length!==1 || configured[0].principalObjectId!==route.principalObjectId)
        throw new Error('session route principal does not match configuration');
      const pool=sessionDeployment.profilePools?.[route.profile];
      if(!pool) throw new Error('a profile-specific session pool is required');
      const lifecycleObserver=createSessionLifecycleObserver({managementEndpoint:pool.managementEndpoint,
        poolName:pool.poolName,region:pool.region,getAccessToken:getSessionToken,
        expectedPrincipalId:sessionControlPrincipalId,sessionRegistry,timeoutMs:30000});
      const controllerToken=controllerTokenFor(route);
      // Session workloads still share the research fixture service, but their
      // reset/evidence credentials are route-scoped just like the HTTP arms.
      const base=createHttpPilotAdapter({agentUrl:pool.managementEndpoint,
        resourceUrl:sessionDeployment.resourceUrl,collectorUrl:sessionDeployment.collectorUrl,
        restrictedUrl:sessionDeployment.restrictedUrl,
        resourceAdminToken:route.credentials.resourceAdmin,collectorAdminToken:route.credentials.collectorAdmin,
        controllerToken,timeoutMs:sessionDeployment.timeoutMs??30000});
      const fixturePreparer=createSessionFixturePreparer({
        managementEndpoint:pool.managementEndpoint,poolName:pool.poolName,
        region:pool.region,blobEndpoint:sessionDeployment.fixtureBlobEndpoint,
        blobResourceId:env.THESIS_BLOB_RESOURCE_ID,
        controllerToken,getControlToken:getSessionToken,
        controlPrincipalId:sessionControlPrincipalId,
        getOwnerToken:getSessionFixtureOwnerToken,ownerPrincipalId:sessionFixtureOwnerPrincipalId,
        sessionRegistry,lifecycleObserver,
        readAudit:createStorageAuditReader({workspaceId,getToken:getLogsToken})});
      const fixtureAdapter=createAzureFixtureAdapter({base,
        blobEndpoint:sessionDeployment.fixtureBlobEndpoint,getControllerToken:getStorageToken,
        getVerifierToken:getStorageToken,prepareSessionFixture:fixturePreparer,
        observeSessionFixture:fixtureRunId=>lifecycleObserver.observe(fixtureRunId)});
      return createSessionPilotAdapter({
        fixtureAdapter,managementEndpoint:pool.managementEndpoint,poolName:pool.poolName,
        region:pool.region,getAccessToken:getSessionToken,
        expectedControllerPrincipalId:sessionControlPrincipalId,
        controllerToken,sessionRegistry,lifecycleObserver,
        // This one must be established by a pilot, not assumed: it decides whether a
        // privileged token is forwarded into the workload.
        headerIsolationVerified:flag(env,'THESIS_SESSION_HEADER_ISOLATION_VERIFIED'),timeoutMs:sessionDeployment.timeoutMs??30000});
    };
  }

  // One factory hook serves every non-HTTP/non-ACI route kind, because that is
  // the contract build-experiment.mjs already consumes for session routes.
  const routeAdapterFactory=route=>{
    const deployment=config.deployments[route?.deployment];
    if(route?.deployment==='azure_container_apps_jobs' && deployment?.kind==='aca_job')
      return acaJobsAdapterFactory(route,deployment);
    if(route?.deployment==='azure_container_apps_sandboxes' && deployment?.kind==='aca_sandbox')
      return acaSandboxAdapterFactory(route,deployment);
    if(sessionFactory) return sessionFactory(route);
    throw new Error('invalid session/ACA route');
  };
  const sessionFactoryForRoute=(needsSessions||needsAcaJobs||needsAcaSandboxes)?routeAdapterFactory:undefined;

  // HTTP workloads also exercise Azure Blob scenarios. Seed each run-scoped
  // fixture before execution; resetting only the research/collector APIs leaves
  // authorized-docs and authorized-records missing (BlobNotFound). The controller
  // identity seeds pilot fixtures; study readiness still depends on separately
  // validated audit and evidence controls.
  const httpFactory=(route,deployment)=>{
    const base=createHttpPilotAdapter({agentUrl:route.agentUrl ?? deployment.agentUrl,
      resourceUrl:deployment.resourceUrl,collectorUrl:deployment.collectorUrl,restrictedUrl:deployment.restrictedUrl,
      resourceAdminToken:route.credentials.resourceAdmin,collectorAdminToken:route.credentials.collectorAdmin,
      controllerToken:route.credentials.controller,
      ...(route.credentials.functionKey===undefined?{}:{functionKey:route.credentials.functionKey}),
      ...(deployment.timeoutMs===undefined?{}:{timeoutMs:deployment.timeoutMs})});
    return createAzureFixtureAdapter({base,blobEndpoint:fixtureBlobEndpoint,
      getControllerToken:getStorageToken,getVerifierToken:getStorageToken,
      ...externalNamespaceMode(deployment),
      timeoutMs:deployment.timeoutMs??15000});
  };

  if(missing.size) throw new Error(`missing live dependency environment: ${[...missing].sort().join(', ')}`);

  // Session capability means exactly one thing: this arm realizes U6/U8 as the
  // explicitly configured external Blob container namespaces. It is never
  // network-denial evidence; that stays in the denial reader's capability map.
  const sessionCapabilities=Object.fromEntries(config.routes
    .filter(route=>selectedRoutes.has(`${route.deployment}:${route.profile}`))
    .filter(route=>['http','aca_job','aca_sandbox'].includes(config.deployments[route.deployment]?.kind) &&
      config.deployments[route.deployment].sessionDataStore==='azure_blob_external_namespace')
    .map(route=>[route.deployment,true]));

  return {denialReader,blobVerifier,collectorVerifier,collectorEffectMonitor,resourceVerifier,
    httpFactory,
    ...(sessionFactoryForRoute?{sessionFactory:sessionFactoryForRoute}:{}),
    laneFor:createLaneSelector(config),notes,sessionCapabilities};
}
